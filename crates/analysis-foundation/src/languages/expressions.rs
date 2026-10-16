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
}

impl TreeAdapter {
    pub(super) fn straight_line(
        &self,
        node: Node<'_>,
        body: Node<'_>,
        source: &str,
        function: &Function,
        expected: Option<&Type>,
    ) -> Option<(Function, Covered)> {
        let mut builder = Builder {
            adapter: self,
            source,
            function: function.clone(),
            bindings: BTreeMap::new(),
            instructions: vec![],
            covered: Covered::new(),
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
                    "expression_statement" => builder.assignment(*children(statement).first()?)?,
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
                return None;
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
            "entry".into(),
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
    fn mark(&mut self, n: Node<'_>) {
        self.covered
            .insert((n.start_byte(), n.end_byte(), n.kind().into()));
    }
    fn emit(&mut self, n: Node<'_>, ty: Type, action: impl FnOnce(ValueId) -> Action) -> ValueId {
        let id = ValueId(format!("expression:{}", self.instructions.len()));
        self.function.values.insert(id.clone(), ty);
        self.instructions.push(Instruction {
            id: InstructionId(format!("instruction:{}", self.instructions.len())),
            source: span(n),
            exceptional: None,
            action: action(id.clone()),
        });
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
