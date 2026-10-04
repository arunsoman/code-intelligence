package ledger

import "sync"

type Ledger struct {
	mu      sync.Mutex
	Balance int
}

func (l *Ledger) Reserve(amount int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if amount < 0 {
		panic("negative amount")
	}
	l.Balance -= amount
	l.record(amount)
}

func (l *Ledger) record(amount int) {}

func Round(x int) int {
	return normalise(x)
}
