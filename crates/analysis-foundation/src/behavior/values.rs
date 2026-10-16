use super::*;
fn int(l: &Literal) -> Result<i128, String> {
    if let Literal::Integer { decimal } = l {
        decimal
            .parse()
            .map_err(|_| "unsupported/noncanonical integer".into())
    } else {
        Err("integer required".into())
    }
}
fn float(l: &Literal) -> Result<f64, String> {
    if let Literal::FloatBits { hex } = l {
        match hex.len() {
            8 => Ok(f32::from_bits(u32::from_str_radix(hex, 16).map_err(|_| "float bits")?) as f64),
            16 => Ok(f64::from_bits(
                u64::from_str_radix(hex, 16).map_err(|_| "float bits")?,
            )),
            _ => Err("float width".into()),
        }
    } else {
        Err("float required".into())
    }
}
pub(super) fn natural_type(l: &Literal) -> Result<Type, String> {
    Ok(match l {
        Literal::Unit => Type::Unit,
        Literal::Bool { .. } => Type::Bool,
        Literal::Utf8 { .. } => Type::String,
        Literal::Integer { .. } => {
            int(l)?;
            Type::Integer {
                bits: None,
                signed: true,
            }
        }
        Literal::FloatBits { hex } => {
            float(l)?;
            Type::Float {
                format: if hex.len() == 8 {
                    FloatFormat::Binary32
                } else {
                    FloatFormat::Binary64
                },
            }
        }
        _ => return Err("literal outside finite checker domain".into()),
    })
}
pub(super) fn typed(l: &Literal, t: &Type) -> Result<(), String> {
    match (l, t) {
        (Literal::Unit, Type::Unit) | (Literal::Bool { .. }, Type::Bool) => Ok(()),
        (Literal::Utf8 { value }, Type::String) if value.len() <= 65536 => Ok(()),
        (
            Literal::Integer { decimal },
            Type::Integer {
                bits: Some(bits),
                signed,
            },
        ) if [8, 16, 32, 64].contains(bits) => {
            let n = int(l)?;
            if n.to_string() != *decimal {
                return Err("noncanonical integer".into());
            }
            let (min, max) = if *signed {
                (-(1i128 << (*bits - 1)), (1i128 << (*bits - 1)) - 1)
            } else {
                (0, (1i128 << bits) - 1)
            };
            if n < min || n > max {
                Err("integer out of type range".into())
            } else {
                Ok(())
            }
        }
        (Literal::Integer { decimal }, Type::Integer { bits: None, signed }) => {
            let n = int(l)?;
            if n.to_string() != *decimal || (!signed && n < 0) {
                Err("noncanonical/out-of-range integer".into())
            } else {
                Ok(())
            }
        }
        (Literal::FloatBits { hex }, Type::Float { format })
            if hex.len()
                == if *format == FloatFormat::Binary32 {
                    8
                } else {
                    16
                } =>
        {
            float(l).map(|_| ())
        }
        _ => Err("unsupported or mismatched concrete value type".into()),
    }
}
pub(super) fn equal(a: &Literal, b: &Literal) -> Result<bool, String> {
    Ok(match (a, b) {
        (Literal::FloatBits { .. }, Literal::FloatBits { .. }) => float(a)? == float(b)?,
        (Literal::Integer { .. }, Literal::Integer { .. }) => int(a)? == int(b)?,
        (Literal::Bool { value: a }, Literal::Bool { value: b }) => a == b,
        (Literal::Utf8 { value: a }, Literal::Utf8 { value: b }) => a == b,
        (Literal::Unit, Literal::Unit) => true,
        _ => return Err("comparison type mismatch".into()),
    })
}
fn less(a: &Literal, b: &Literal) -> Result<bool, String> {
    match (a, b) {
        (Literal::FloatBits { .. }, Literal::FloatBits { .. }) => Ok(float(a)? < float(b)?),
        (Literal::Integer { .. }, Literal::Integer { .. }) => Ok(int(a)? < int(b)?),
        _ => Err("ordered comparison unsupported".into()),
    }
}
fn wrap(n: i128, t: &Type) -> Result<Literal, String> {
    let n = match t {
        Type::Integer {
            bits: Some(bits),
            signed,
        } if [8, 16, 32, 64].contains(bits) => {
            let modulus = 1i128 << bits;
            let n = n.rem_euclid(modulus);
            if *signed && n >= modulus / 2 {
                n - modulus
            } else {
                n
            }
        }
        Type::Integer { bits: None, .. } => n,
        _ => return Err("unsupported integer arithmetic width".into()),
    };
    let result = Literal::Integer {
        decimal: n.to_string(),
    };
    typed(&result, t)?;
    Ok(result)
}
fn float_result(n: f64, t: &Type) -> Result<Literal, String> {
    Ok(Literal::FloatBits {
        hex: match t {
            Type::Float {
                format: FloatFormat::Binary32,
            } => format!("{:08x}", (n as f32).to_bits()),
            Type::Float {
                format: FloatFormat::Binary64,
            } => format!("{:016x}", n.to_bits()),
            _ => return Err("float result type".into()),
        },
    })
}
pub(super) fn unary(op: &UnaryOp, a: &Literal, t: &Type) -> Result<Literal, String> {
    match (op, a) {
        (UnaryOp::Not, Literal::Bool { value }) => Ok(Literal::Bool { value: !value }),
        (UnaryOp::Negate, Literal::Integer { .. }) => wrap(
            int(a)?
                .checked_neg()
                .ok_or("integer evaluator range exhausted")?,
            t,
        ),
        (UnaryOp::Negate, Literal::FloatBits { .. }) => float_result(-float(a)?, t),
        _ => Err("unsupported unary operation".into()),
    }
}
pub(super) enum Arithmetic {
    Value(Literal),
    Raise,
}
pub(super) fn binary(
    op: &BinaryOp,
    a: &Literal,
    b: &Literal,
    t: &Type,
) -> Result<Arithmetic, String> {
    use Arithmetic::*;
    if *op == BinaryOp::Equal {
        return Ok(Value(Literal::Bool {
            value: equal(a, b)?,
        }));
    }
    if *op == BinaryOp::LessThan {
        return Ok(Value(Literal::Bool { value: less(a, b)? }));
    }
    if let (Literal::Bool { value: a }, Literal::Bool { value: b }) = (a, b) {
        return Ok(Value(Literal::Bool {
            value: match op {
                BinaryOp::And => *a && *b,
                BinaryOp::Or => *a || *b,
                _ => return Err("unsupported boolean operator".into()),
            },
        }));
    }
    if matches!(a, Literal::FloatBits { .. }) {
        let a = float(a)?;
        let b = float(b)?;
        let n = if matches!(
            t,
            Type::Float {
                format: FloatFormat::Binary32
            }
        ) {
            let a = a as f32;
            let b = b as f32;
            (match op {
                BinaryOp::Add => a + b,
                BinaryOp::Subtract => a - b,
                BinaryOp::Multiply => a * b,
                BinaryOp::Divide => a / b,
                BinaryOp::Remainder => a % b,
                _ => return Err("unsupported float operator".into()),
            }) as f64
        } else {
            match op {
                BinaryOp::Add => a + b,
                BinaryOp::Subtract => a - b,
                BinaryOp::Multiply => a * b,
                BinaryOp::Divide => a / b,
                BinaryOp::Remainder => a % b,
                _ => return Err("unsupported float operator".into()),
            }
        };
        return Ok(Value(float_result(n, t)?));
    }
    let a = int(a)?;
    let b = int(b)?;
    if b == 0 && matches!(op, BinaryOp::Divide | BinaryOp::Remainder) {
        return Ok(Raise);
    }
    let n = match op {
        BinaryOp::Add => a.checked_add(b),
        BinaryOp::Subtract => a.checked_sub(b),
        BinaryOp::Multiply => a.checked_mul(b),
        BinaryOp::Divide => a.checked_div(b),
        BinaryOp::Remainder => a.checked_rem(b),
        _ => return Err("unsupported integer operator".into()),
    }
    .ok_or("integer evaluator range exhausted")?;
    Ok(Value(wrap(n, t)?))
}
pub(super) fn evaluate(
    p: &Predicate,
    args: &[Literal],
    ret: Option<&Literal>,
) -> Result<bool, String> {
    fn operand<'a>(
        o: &'a Operand,
        args: &'a [Literal],
        ret: Option<&'a Literal>,
    ) -> Result<&'a Literal, String> {
        match o {
            Operand::Argument { index } => args.get(*index).ok_or("argument missing".into()),
            Operand::Return => ret.ok_or("return missing".into()),
            Operand::Literal { value } => Ok(value),
        }
    }
    match p {
        Predicate::Equal { left, right } => {
            equal(operand(left, args, ret)?, operand(right, args, ret)?)
        }
        Predicate::LessThan { left, right } => {
            less(operand(left, args, ret)?, operand(right, args, ret)?)
        }
        Predicate::Not { value } => Ok(!evaluate(value, args, ret)?),
        Predicate::And { values } => {
            for p in values {
                if !evaluate(p, args, ret)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        Predicate::Or { values } => {
            for p in values {
                if evaluate(p, args, ret)? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
    }
}
