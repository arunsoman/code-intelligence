use std::sync::Mutex;

pub struct Bank { pub a: Mutex<i64>, pub b: Mutex<i64> }

impl Bank {
    // A realizable inversion: one order here, the opposite below.
    pub fn a_then_b(&self) {
        let ga = self.a.lock().unwrap();
        let gb = self.b.lock().unwrap();
        let _ = (*ga, *gb);
    }
    pub fn b_then_a(&self) {
        let gb = self.b.lock().unwrap();
        let ga = self.a.lock().unwrap();
        let _ = (*ga, *gb);
    }
    // Control: the first guard is dropped by its block before the second lock is taken, so nothing is ever held while waiting.
    pub fn scoped_a_then_b(&self) {
        { let ga = self.a.lock().unwrap(); let _ = *ga; }
        let gb = self.b.lock().unwrap();
        let _ = *gb;
    }
}
