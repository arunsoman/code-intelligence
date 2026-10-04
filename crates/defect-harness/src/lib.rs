//! Reviewed finite concurrency fixtures. These properties are shared by the
//! failing and corrected operations. They do not model arbitrary application code.

#[cfg(test)]
mod tests {
    use loom::sync::{atomic::{AtomicUsize, Ordering}, Arc, Mutex};
    use loom::thread;

    fn model(check: impl Fn() + Send + Sync + 'static) {
        let mut builder = loom::model::Builder::new();
        builder.max_threads = 3;
        builder.max_branches = 100;
        builder.preemption_bound = Some(2);
        builder.check(check);
    }

    fn increments(atomic_update: bool) {
        model(move || {
            let value = Arc::new(AtomicUsize::new(0));
            let mut workers = Vec::new();
            for _ in 0..2 {
                let shared = value.clone();
                workers.push(thread::spawn(move || {
                    if atomic_update { shared.fetch_add(1, Ordering::SeqCst); }
                    else {
                        let before = shared.load(Ordering::SeqCst);
                        shared.store(before + 1, Ordering::SeqCst);
                    }
                }));
            }
            for worker in workers { worker.join().unwrap(); }
            assert_eq!(value.load(Ordering::SeqCst), 2, "one retained increment per completed operation");
        });
    }

    #[test]
    #[should_panic(expected = "one retained increment per completed operation")]
    fn dp03_atomic_memory_can_still_have_a_logical_race() { increments(false); }

    #[test]
    fn dp12_fixed_operation_preserves_the_same_property() { increments(true); }

    #[test]
    fn dp09_mutex_preserves_sum_during_transfer() {
        model(|| {
            let balances = Arc::new(Mutex::new((10usize, 10usize)));
            let other = balances.clone();
            let worker = thread::spawn(move || {
                let mut state = other.lock().unwrap();
                state.0 -= 1; state.1 += 1;
                assert_eq!(state.0 + state.1, 20);
            });
            {
                let mut state = balances.lock().unwrap();
                state.1 -= 2; state.0 += 2;
                assert_eq!(state.0 + state.1, 20);
            }
            worker.join().unwrap();
            let state = balances.lock().unwrap();
            assert_eq!(*state, (11, 9));
        });
    }
}
