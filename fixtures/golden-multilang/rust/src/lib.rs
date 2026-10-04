mod util;

pub trait Speak {
    fn speak(&self) -> String;
}

pub struct Dog;
impl Speak for Dog {
    fn speak(&self) -> String {
        util::helper("woof")
    }
}

pub fn run(animal: Box<dyn Speak>) -> String {
    let local = util::helper("x");
    let said = animal.speak();
    format!("{local}{said}")
}
