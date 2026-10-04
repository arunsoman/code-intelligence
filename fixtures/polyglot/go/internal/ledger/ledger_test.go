package ledger

import "testing"

func TestReserve(t *testing.T) {
	l := &Ledger{}
	l.Reserve(1)
}
