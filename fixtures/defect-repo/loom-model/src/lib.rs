//! Two models of the same operation. The property is the same in both: after two completed increments the value is two.
#[cfg(test)]
mod tests {
    use loom::sync::{atomic::{AtomicUsize, Ordering}, Arc};
    use loom::thread;

    fn two_increments(read_then_write: bool) {
        let mut b = loom::model::Builder::new();
        b.max_threads = 3; b.preemption_bound = Some(3);
        b.check(move || {
            let v = Arc::new(AtomicUsize::new(0));
            let hs: Vec<_> = (0..2).map(|_| { let v = v.clone(); thread::spawn(move || {
                if read_then_write { let x = v.load(Ordering::SeqCst); v.store(x + 1, Ordering::SeqCst); } else { v.fetch_add(1, Ordering::SeqCst); }
            }) }).collect();
            for h in hs { h.join().unwrap(); }
            assert_eq!(v.load(Ordering::SeqCst), 2, "two completed increments must leave two");
        });
    }
    #[test] fn lost_update_model() { two_increments(true); }
    #[test] fn fixed_model() { two_increments(false); }
}
