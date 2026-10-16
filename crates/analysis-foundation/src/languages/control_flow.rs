use super::*;

impl Builder<'_> {
    pub(super) fn exceptional(&self) -> ExceptionalExit {
        self.handler
            .clone()
            .map(|target| ExceptionalExit::Block { target })
            .unwrap_or(ExceptionalExit::Propagate)
    }
    fn block_id(&mut self, label: &str) -> BlockId {
        let id = BlockId(format!("flow:{}:{label}", self.flow_count));
        self.flow_count += 1;
        id
    }
    fn finish(&mut self, terminator: Terminator) {
        self.function.blocks.insert(
            self.current.clone(),
            Block {
                source: self.function.source.clone(),
                instructions: std::mem::take(&mut self.instructions),
                terminator,
            },
        );
        self.closed = true;
    }
    fn start(&mut self, id: BlockId, bindings: BTreeMap<String, Binding>) {
        self.current = id;
        self.bindings = bindings;
        self.instructions.clear();
        self.closed = false;
    }
    pub(super) fn return_value(&mut self, value: Option<ValueId>) -> Option<()> {
        let ty = value
            .as_ref()
            .map(|v| self.function.values[v].clone())
            .unwrap_or(Type::Unit);
        if self.return_type.as_ref().is_some_and(|t| t != &ty) {
            return None;
        }
        self.return_type = Some(ty);
        self.finish(Terminator::Return { value });
        Some(())
    }
    pub(super) fn statements(
        &mut self,
        node: Node<'_>,
        expected: Option<&Type>,
        depth: usize,
    ) -> Option<()> {
        if depth >= 64 {
            return None;
        }
        if matches!(node.kind(), "statement_block" | "block" | "else_clause") {
            let outer_names: BTreeSet<_> = self.bindings.keys().cloned().collect();
            let nodes: Vec<_> = children(node)
                .into_iter()
                .filter(|n| !matches!(n.kind(), "comment" | "line_comment" | "block_comment"))
                .collect();
            if nodes.len() > 4096 {
                return None;
            }
            for statement in nodes {
                if self.closed {
                    return None;
                }
                self.statements(statement, expected, depth + 1)?;
            }
            self.bindings.retain(|name, _| outer_names.contains(name));
        } else {
            match node.kind() {
                "local_variable_declaration" | "lexical_declaration" | "variable_declaration" => {
                    if node.kind() == "variable_declaration" && depth > 1 {
                        return None;
                    }
                    self.declaration(node)?
                }
                "expression_statement" => {
                    let expression = *children(node).first()?;
                    if matches!(expression.kind(), "call_expression" | "method_invocation") {
                        self.invoke(expression, None, false, 0)?;
                    } else {
                        self.assignment(expression)?;
                    }
                }
                "return_statement" => {
                    let value = children(node)
                        .first()
                        .map(|n| self.expression(*n, expected, 0))
                        .transpose_option()?;
                    self.return_value(value)?;
                }
                "if_statement" => self.conditional(node, expected, depth + 1)?,
                "while_statement" | "for_statement" => {
                    self.loop_statement(node, expected, depth + 1)?
                }
                "throw_statement" => {
                    if self.handler.is_some() {
                        return None;
                    }
                    let expression = *children(node).first()?;
                    let saved = self.clone();
                    let value = if let Some(value) = self.expression(expression, None, 0) {
                        value
                    } else {
                        *self = saved;
                        let ty = opaque_type("exception expression evaluation not modeled");
                        let value = self.emit(expression, ty, |result| Action::Opaque {
                            reason: "opaque throw expression evaluation".into(),
                            inputs: vec![],
                            outputs: vec![result],
                        });
                        let exceptional = self.exceptional();
                        self.instructions.last_mut()?.exceptional = Some(exceptional);
                        value
                    };
                    self.finish(Terminator::Raise { value: Some(value) });
                }
                "try_statement" => self.try_catch(node, expected, depth + 1)?,
                "empty_statement" => {}
                _ => return None,
            }
        }
        self.mark(node);
        Some(())
    }
    fn conditional(&mut self, node: Node<'_>, expected: Option<&Type>, depth: usize) -> Option<()> {
        let condition =
            self.expression(node.child_by_field_name("condition")?, Some(&Type::Bool), 0)?;
        if self.function.values[&condition] != Type::Bool {
            return None;
        }
        let before = self.bindings.clone();
        let yes = self.block_id("then");
        let no = self.block_id("else");
        let join = self.block_id("join");
        self.finish(Terminator::Branch {
            condition,
            then_block: yes.clone(),
            else_block: no.clone(),
        });
        self.start(yes, before.clone());
        self.statements(node.child_by_field_name("consequence")?, expected, depth)?;
        let mut incoming = vec![];
        if !self.closed {
            incoming.push(self.bindings.clone());
            self.finish(Terminator::Goto {
                target: join.clone(),
            });
        }
        self.start(no, before.clone());
        if let Some(alternative) = node.child_by_field_name("alternative") {
            self.statements(alternative, expected, depth)?;
        }
        if !self.closed {
            incoming.push(self.bindings.clone());
            self.finish(Terminator::Goto {
                target: join.clone(),
            });
        }
        self.join(join, &before, incoming, node)
    }
    fn join(
        &mut self,
        id: BlockId,
        before: &BTreeMap<String, Binding>,
        incoming: Vec<BTreeMap<String, Binding>>,
        source: Node<'_>,
    ) -> Option<()> {
        if incoming.is_empty() {
            self.closed = true;
            return Some(());
        }
        self.start(id, before.clone());
        for (name, binding) in before {
            let values: Vec<_> = incoming
                .iter()
                .map(|env| env.get(name).map(|b| b.value.clone()))
                .collect::<Option<_>>()?;
            let value = if values.iter().all(|v| v == &values[0]) {
                values[0].clone()
            } else {
                let ty = self.function.values[&values[0]].clone();
                if values.iter().any(|v| self.function.values[v] != ty) {
                    return None;
                }
                self.emit(source, ty, |result| Action::Opaque {
                    reason: "control-flow join overapproximated; path-specific value unknown"
                        .into(),
                    inputs: values,
                    outputs: vec![result],
                })
            };
            self.bindings.insert(
                name.clone(),
                Binding {
                    value,
                    mutable: binding.mutable,
                },
            );
        }
        Some(())
    }
    fn loop_statement(
        &mut self,
        node: Node<'_>,
        expected: Option<&Type>,
        depth: usize,
    ) -> Option<()> {
        let outer_names: BTreeSet<_> = self.bindings.keys().cloned().collect();
        let mut scoped_initializer = false;
        if let Some(initializer) = node
            .child_by_field_name("initializer")
            .or_else(|| node.child_by_field_name("init"))
        {
            if matches!(
                initializer.kind(),
                "local_variable_declaration" | "lexical_declaration" | "variable_declaration"
            ) {
                scoped_initializer = initializer.kind() != "variable_declaration";
                self.declaration(initializer)?;
            } else {
                self.assignment(initializer)?;
            }
        }
        let before = self.bindings.clone();
        let header = self.block_id("loop-header");
        let body = self.block_id("loop-body");
        let exit = self.block_id("loop-exit");
        self.finish(Terminator::Goto {
            target: header.clone(),
        });
        self.start(header.clone(), before.clone());
        let mut merges = vec![];
        for (name, binding) in &before {
            if !binding.mutable {
                continue;
            }
            let ty = self.function.values[&binding.value].clone();
            let input = binding.value.clone();
            let position = self.instructions.len();
            let value = self.emit(node, ty, |result| Action::Opaque {
                reason: "loop-carried value overapproximated; iteration relation unknown".into(),
                inputs: vec![input],
                outputs: vec![result],
            });
            self.bindings.get_mut(name)?.value = value;
            merges.push((name.clone(), position));
        }
        let loop_bindings = self.bindings.clone();
        let header_block = self.current.clone();
        let condition =
            self.expression(node.child_by_field_name("condition")?, Some(&Type::Bool), 0)?;
        if self.function.values[&condition] != Type::Bool {
            return None;
        }
        let exit_bindings = self.bindings.clone();
        self.finish(Terminator::Branch {
            condition,
            then_block: body.clone(),
            else_block: exit.clone(),
        });
        self.start(body, exit_bindings.clone());
        self.statements(node.child_by_field_name("body")?, expected, depth)?;
        if !self.closed {
            if let Some(update) = node
                .child_by_field_name("update")
                .or_else(|| node.child_by_field_name("increment"))
            {
                self.assignment(update)?;
            }
            for (name, position) in merges {
                let value = self.bindings.get(&name)?.value.clone();
                if self.function.values[&value] != self.function.values[&loop_bindings[&name].value]
                {
                    return None;
                }
                let Action::Opaque { inputs, .. } =
                    &mut self.function.blocks.get_mut(&header_block)?.instructions[position].action
                else {
                    return None;
                };
                if !inputs.contains(&value) {
                    inputs.push(value);
                }
            }
            self.finish(Terminator::Goto { target: header });
        }
        self.start(exit, exit_bindings);
        if scoped_initializer {
            self.bindings.retain(|name, _| outer_names.contains(name));
        }
        Some(())
    }
    fn try_catch(&mut self, node: Node<'_>, expected: Option<&Type>, depth: usize) -> Option<()> {
        if matches!(self.adapter.profile, Profile::Java)
            || node.child_by_field_name("finalizer").is_some()
            || children(node).iter().any(|n| n.kind() == "finally_clause")
        {
            return None;
        }
        let catch = node.child_by_field_name("handler")?;
        let body = node.child_by_field_name("body")?;
        let before = self.bindings.clone();
        let handler = self.block_id("catch");
        let join = self.block_id("try-join");
        let previous = self.handler.replace(handler.clone());
        self.statements(body, expected, depth)?;
        self.handler = previous;
        let mut incoming = vec![];
        if !self.closed {
            incoming.push(self.bindings.clone());
            self.finish(Terminator::Goto {
                target: join.clone(),
            });
        }
        self.start(handler, before.clone());
        self.havoc_locals(span(catch));
        if let Some(parameter) = catch.child_by_field_name("parameter") {
            if parameter.kind() != "identifier" {
                return None;
            }
            let value = self.emit(
                parameter,
                opaque_type("caught exception value unknown"),
                |result| Action::Opaque {
                    reason: "catch parameter from exceptional predecessor".into(),
                    inputs: vec![],
                    outputs: vec![result],
                },
            );
            self.bindings.insert(
                raw(parameter, self.source).into(),
                Binding {
                    value,
                    mutable: true,
                },
            );
        }
        self.statements(catch.child_by_field_name("body")?, expected, depth)?;
        if !self.closed {
            incoming.push(self.bindings.clone());
            self.finish(Terminator::Goto {
                target: join.clone(),
            });
        }
        self.join(join, &before, incoming, node)
    }
}
