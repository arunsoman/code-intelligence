//! Conservative straight-line lowering. Unsupported statements invalidate the whole
//! candidate body, so a later return cannot erase earlier effects.
use super::*;

struct Binding {
    value: ValueId,
    mutable: bool,
}
struct Builder<'a> {
    adapter: &'a TreeAdapter,
    source: &'a str,
    function: Function,
    bindings: BTreeMap<String, Binding>,
    instructions: Vec<Instruction>,
    covered: Covered,
    resolutions: &'a calls::Resolutions,
    current: BlockId,
    sequence: usize,
    call_count: usize,
}

impl TreeAdapter {
    pub(super) fn straight_line(
        &self,
        node: Node<'_>,
        body: Node<'_>,
        source: &str,
        function: &Function,
        expected: Option<&Type>,
        resolutions: &calls::Resolutions,
    ) -> Option<(Function, Covered)> {
        let mut builder = Builder {
            adapter: self,
            source,
            function: function.clone(),
            bindings: BTreeMap::new(),
            instructions: vec![],
            covered: Covered::new(),
            resolutions,
            current: "entry".into(),
            sequence: 0,
            call_count: 0,
        };
        let params = node
            .child_by_field_name("parameters")
            .or_else(|| node.child_by_field_name("parameter"));
        if let Some(params) = params {
            let nodes = if params.kind() == "identifier" {
                vec![params]
            } else {
                children(params)
            };
            for (p, id) in nodes.into_iter().zip(&function.parameters) {
                let name = if p.kind() == "identifier" {
                    p
                } else {
                    p.child_by_field_name("name")
                        .or_else(|| p.child_by_field_name("pattern"))?
                };
                if name.kind() != "identifier"
                    || builder
                        .bindings
                        .insert(
                            raw(name, source).into(),
                            Binding {
                                value: id.clone(),
                                mutable: !raw(p, source)
                                    .split(|c: char| !c.is_alphanumeric())
                                    .any(|word| word == "final"),
                            },
                        )
                        .is_some()
                {
                    return None;
                }
            }
        }
        let result = if !matches!(body.kind(), "statement_block" | "block") {
            if node.kind() != "arrow_function" {
                return None;
            }
            Some(builder.expression(body, expected, 0)?)
        } else {
            let statements: Vec<_> = children(body)
                .into_iter()
                .filter(|n| !matches!(n.kind(), "comment" | "line_comment" | "block_comment"))
                .collect();
            if statements.is_empty() || statements.len() > 4096 {
                return None;
            }
            let mut result = None;
            for (index, statement) in statements.iter().copied().enumerate() {
                match statement.kind() {
                    "local_variable_declaration"
                    | "lexical_declaration"
                    | "variable_declaration" => builder.declaration(statement)?,
                    "expression_statement" => {
                        let expression = *children(statement).first()?;
                        if matches!(expression.kind(), "call_expression" | "method_invocation") {
                            builder.invoke(expression, None, false, 0)?;
                        } else {
                            builder.assignment(expression)?;
                        }
                    }
                    "return_statement" => {
                        // Preserve trailing source semantics conservatively, including unreachable statements.
                        if index + 1 != statements.len() {
                            return None;
                        }
                        if let Some(expression) = children(statement).first() {
                            result = Some(builder.expression(*expression, expected, 0)?);
                        } else if expected.is_some_and(|t| t != &Type::Unit) {
                            return None;
                        }
                    }
                    _ => return None,
                }
                builder.mark(statement);
            }
            if statements.last()?.kind() != "return_statement" {
                if expected.is_some_and(|ty| ty != &Type::Unit) {
                    return None;
                }
                if !builder
                    .function
                    .blocks
                    .values()
                    .any(|b| matches!(b.terminator, Terminator::Invoke { .. }))
                {
                    return None;
                }
            }
            result
        };
        let return_type = result
            .as_ref()
            .map(|v| builder.function.values[v].clone())
            .unwrap_or(Type::Unit);
        if expected.is_some_and(|t| t != &return_type) {
            return None;
        }
        builder.function.return_type = return_type;
        builder.function.blocks.insert(
            builder.current.clone(),
            Block {
                source: span(node),
                instructions: builder.instructions,
                terminator: Terminator::Return { value: result },
            },
        );
        builder
            .covered
            .insert((node.start_byte(), node.end_byte(), node.kind().into()));
        Some((builder.function, builder.covered))
    }
}

impl Builder<'_> {
    fn invoke(
        &mut self,
        n: Node<'_>,
        expected: Option<&Type>,
        capture: bool,
        depth: usize,
    ) -> Option<Option<ValueId>> {
        if depth >= 128 {
            return None;
        }
        let arguments = n.child_by_field_name("arguments")?;
        let callee = n
            .child_by_field_name("function")
            .or_else(|| n.child_by_field_name("name"))?;
        let prefix = &self.source[n.start_byte()..arguments.start_byte()];
        if prefix.contains("?.") || n.child_by_field_name("type_arguments").is_some() {
            return None;
        }
        let candidate = self
            .resolutions
            .get(&(n.start_byte(), n.end_byte()))
            .cloned();
        let java = matches!(self.adapter.profile, Profile::Java);
        if !java || n.child_by_field_name("object").is_some() {
            // Receiver/member lookup may run getters or throw BEFORE argument evaluation.
            // Preserve that opaque phase explicitly rather than evaluate it after arguments.
            let evaluation_source = Span {
                document: span(n).document,
                start_byte: n.start_byte() as u64,
                end_byte: callee.end_byte() as u64,
            };
            let mut inputs = BTreeSet::new();
            let mut lookup_nodes = vec![callee];
            if let Some(object) = n.child_by_field_name("object") {
                lookup_nodes.push(object);
            }
            while let Some(node) = lookup_nodes.pop() {
                if node.kind() == "identifier" {
                    if let Some(binding) = self.bindings.get(raw(node, self.source)) {
                        inputs.insert(binding.value.clone());
                    }
                }
                lookup_nodes.extend(children(node));
            }
            let inputs = inputs.into_iter().collect();
            self.instructions.push(Instruction {
                id: InstructionId(format!("instruction:{}", self.sequence)),
                source: evaluation_source,
                exceptional: Some(ExceptionalExit::Propagate),
                action: Action::Opaque {
                    reason: "unmodeled callee/receiver lookup before arguments".into(),
                    inputs,
                    outputs: vec![],
                },
            });
            self.sequence += 1;
            if !java {
                self.havoc_locals(span(callee));
            }
        }
        let mut values = vec![];
        for arg in children(arguments)
            .into_iter()
            .filter(|n| !matches!(n.kind(), "comment" | "line_comment" | "block_comment"))
        {
            if matches!(arg.kind(), "spread_element" | "spread_argument") {
                return None;
            }
            // Infer argument types independently; do not force the candidate's signature
            // onto literals or invent narrowing/promotions to make resolution succeed.
            values.push(self.expression(arg, None, depth + 1)?);
        }
        let resolved = candidate.filter(|c| {
            c.parameters.len() == values.len()
                && c.parameters
                    .iter()
                    .zip(&values)
                    .all(|(ty, v)| ty == &self.function.values[v])
        });
        let result_type = resolved
            .as_ref()
            .map(|c| c.return_type.clone())
            .or_else(|| expected.cloned())
            .unwrap_or_else(|| opaque_type("unresolved call result type"));
        if expected.is_some_and(|ty| resolved.is_some() && ty != &result_type) {
            return None;
        }
        let binding = if let Some(c) = resolved {
            crate::semantic_ir::Binding::Resolved {
                targets: BTreeSet::from([c.target]),
                evidence: c.evidence,
            }
        } else {
            crate::semantic_ir::Binding::Unresolved {
                reason: format!(
                    "unresolved call {}; runtime target, result and outcome are not established; contextual result types are assumptions",
                    prefix.trim()
                ),
                evidence: span(n),
            }
        };
        let call_index = self.call_count;
        self.call_count += 1;
        let result = capture.then(|| ValueId(format!("call-result:{call_index}")));
        if let Some(value) = &result {
            self.function.values.insert(value.clone(), result_type);
        }
        let normal = BlockId(format!("after-call:{call_index}"));
        self.function.blocks.insert(
            self.current.clone(),
            Block {
                source: self.function.source.clone(),
                instructions: std::mem::take(&mut self.instructions),
                terminator: Terminator::Invoke {
                    result: result.clone(),
                    call: CallSite {
                        arguments: values,
                        binding,
                    },
                    normal: normal.clone(),
                    exceptional: ExceptionalExit::Propagate,
                },
            },
        );
        self.current = normal;
        if !java {
            self.havoc_locals(span(n));
        }
        self.mark(n);
        Some(result)
    }
    /// Unknown ECMAScript code (including direct eval or accessors) must not leave
    /// stale local values masquerading as facts. This is an explicit approximation.
    fn havoc_locals(&mut self, source: Span) {
        if self.bindings.is_empty() {
            return;
        }
        let mut inputs = vec![];
        let mut outputs = vec![];
        for (index, binding) in self.bindings.values_mut().enumerate() {
            inputs.push(binding.value.clone());
            let value = ValueId(format!("unknown-local:{}:{index}", self.sequence));
            self.function.values.insert(
                value.clone(),
                opaque_type(
                    "local state may change during unresolved callee evaluation or invocation",
                ),
            );
            binding.value = value.clone();
            outputs.push(value);
        }
        self.instructions.push(Instruction {
            id: InstructionId(format!("instruction:{}", self.sequence)),
            source,
            exceptional: None,
            action: Action::Opaque {
                reason: "conservative local-state invalidation around unresolved ECMAScript code"
                    .into(),
                inputs,
                outputs,
            },
        });
        self.sequence += 1;
    }
    fn mark(&mut self, n: Node<'_>) {
        self.covered
            .insert((n.start_byte(), n.end_byte(), n.kind().into()));
    }
    fn emit(&mut self, n: Node<'_>, ty: Type, action: impl FnOnce(ValueId) -> Action) -> ValueId {
        let id = ValueId(format!("expression:{}", self.sequence));
        self.function.values.insert(id.clone(), ty);
        self.instructions.push(Instruction {
            id: InstructionId(format!("instruction:{}", self.sequence)),
            source: span(n),
            exceptional: None,
            action: action(id.clone()),
        });
        self.sequence += 1;
        self.mark(n);
        id
    }
    fn expression(
        &mut self,
        n: Node<'_>,
        expected: Option<&Type>,
        depth: usize,
    ) -> Option<ValueId> {
        if depth >= 128 {
            return None;
        }
        let intrinsic_java_type = if raw(n, self.source).trim().ends_with(['l', 'L']) {
            Type::Integer {
                bits: Some(64),
                signed: true,
            }
        } else {
            Type::Integer {
                bits: Some(32),
                signed: true,
            }
        };
        let literal_hint = if matches!(self.adapter.profile, Profile::Java) && expected.is_none() {
            Some(&intrinsic_java_type)
        } else {
            expected
        };
        if let Some((literal, ty)) = self.adapter.literal(raw(n, self.source), literal_hint) {
            return Some(self.emit(n, ty, |result| Action::Constant { result, literal }));
        }
        match n.kind() {
            "call_expression" | "method_invocation" => self.invoke(n, expected, true, depth)?,
            "identifier" => {
                let value = self.bindings.get(raw(n, self.source))?.value.clone();
                self.mark(n);
                Some(value)
            }
            "parenthesized_expression" => {
                let cs = children(n);
                if cs.len() != 1 {
                    return None;
                }
                let value = self.expression(cs[0], expected, depth + 1)?;
                self.mark(n);
                Some(value)
            }
            "unary_expression" => {
                let operand_node = n
                    .child_by_field_name("argument")
                    .or_else(|| n.child_by_field_name("operand"))?;
                let operator =
                    raw(n, self.source)[..operand_node.start_byte() - n.start_byte()].trim();
                let operand = self.expression(operand_node, expected, depth + 1)?;
                let ty = self.function.values[&operand].clone();
                let operator = match operator {
                    "!" if ty == Type::Bool => UnaryOp::Not,
                    "-" if arithmetic(&ty) => UnaryOp::Negate,
                    _ => return None,
                };
                Some(self.emit(n, ty, |result| Action::Unary {
                    result,
                    operand,
                    operator,
                }))
            }
            "binary_expression" => {
                let left_node = n.child_by_field_name("left")?;
                let right_node = n.child_by_field_name("right")?;
                let operator = n
                    .child_by_field_name("operator")
                    .map(|op| raw(op, self.source))
                    .unwrap_or_else(|| {
                        self.source[left_node.end_byte()..right_node.start_byte()].trim()
                    });
                // Short-circuit operators require CFG lowering; never emit eager evaluation.
                let comparison = matches!(operator, "<" | "==" | "===");
                let hint = if comparison || matches!(self.adapter.profile, Profile::Java) {
                    None
                } else {
                    expected
                };
                let left = self.expression(left_node, hint, depth + 1)?;
                let ty = self.function.values[&left].clone();
                let right = self.expression(right_node, Some(&ty), depth + 1)?;
                if self.function.values[&right] != ty {
                    return None;
                }
                let java = matches!(self.adapter.profile, Profile::Java);
                let operator = match operator {
                    "+" if arithmetic(&ty) => BinaryOp::Add,
                    "-" if arithmetic(&ty) => BinaryOp::Subtract,
                    "*" if arithmetic(&ty) => BinaryOp::Multiply,
                    "<" if arithmetic(&ty) => BinaryOp::LessThan,
                    "==" if java && (arithmetic(&ty) || ty == Type::Bool) => BinaryOp::Equal,
                    "===" if !java && (arithmetic(&ty) || ty == Type::Bool) => BinaryOp::Equal,
                    _ => return None,
                };
                let result_type = if comparison { Type::Bool } else { ty };
                Some(self.emit(n, result_type, |result| Action::Binary {
                    result,
                    left,
                    right,
                    operator,
                }))
            }
            _ => None,
        }
    }
    fn declaration(&mut self, n: Node<'_>) -> Option<()> {
        let declared = n.child_by_field_name("type");
        let hint = declared
            .map(|t| type_name(raw(t, self.source)))
            .transpose_option()?;
        let first_word = raw(n, self.source)
            .trim_start()
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .next();
        let mutable = !matches!(first_word, Some("const" | "final"));
        let declarations: Vec<_> = children(n)
            .into_iter()
            .filter(|n| n.kind() == "variable_declarator")
            .collect();
        if declarations.is_empty() {
            return None;
        }
        for declaration in declarations {
            let name = declaration.child_by_field_name("name")?;
            if name.kind() != "identifier" {
                return None;
            }
            let key = raw(name, self.source).to_owned();
            if self.bindings.contains_key(&key) {
                return None;
            }
            let local_type = declaration
                .child_by_field_name("type")
                .map(|t| type_name(raw(t, self.source)))
                .transpose_option()?;
            let hint = local_type.as_ref().or(hint.as_ref());
            let value = self.expression(declaration.child_by_field_name("value")?, hint, 0)?;
            let ty = &self.function.values[&value];
            if hint.is_some_and(|t| t != ty) {
                return None;
            }
            self.bindings.insert(key, Binding { value, mutable });
            self.mark(declaration);
            self.mark(name);
        }
        Some(())
    }
    fn assignment(&mut self, n: Node<'_>) -> Option<()> {
        if n.kind() != "assignment_expression" {
            return None;
        }
        let left = n.child_by_field_name("left")?;
        let right = n.child_by_field_name("right")?;
        if left.kind() != "identifier"
            || self.source[left.end_byte()..right.start_byte()].trim() != "="
        {
            return None;
        }
        let key = raw(left, self.source).to_owned();
        let binding = self.bindings.get(&key)?;
        if !binding.mutable {
            return None;
        }
        let ty = self.function.values[&binding.value].clone();
        let operand = self.expression(right, Some(&ty), 0)?;
        if self.function.values[&operand] != ty {
            return None;
        }
        let value = self.emit(n, ty, |result| Action::Copy { result, operand });
        self.bindings.get_mut(&key)?.value = value;
        self.mark(left);
        Some(())
    }
}

fn arithmetic(ty: &Type) -> bool {
    matches!(
        ty,
        Type::Integer {
            bits: Some(32 | 64),
            signed: true
        } | Type::Integer {
            bits: None,
            signed: true
        } | Type::Float {
            format: FloatFormat::Binary64
        }
    )
}

trait TransposeOption<T> {
    fn transpose_option(self) -> Option<Option<T>>;
}
impl<T> TransposeOption<T> for Option<Option<T>> {
    fn transpose_option(self) -> Option<Option<T>> {
        match self {
            Some(Some(t)) => Some(Some(t)),
            Some(None) => None,
            None => Some(None),
        }
    }
}
