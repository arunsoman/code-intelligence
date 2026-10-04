package harness

import "sync"

// Planted: Increment is unsynchronised, so two goroutines calling it race.
type Counter struct{ n int }

func (c *Counter) Increment() { c.n++ }

// Safe: the same counter behind a mutex.
type SafeCounter struct {
	mu sync.Mutex
	n  int
}

func (c *SafeCounter) Increment() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.n++
}
