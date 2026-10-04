package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"sync"
	"time"
)

type Bank struct {
	accounts sync.Mutex
	ledger   sync.Mutex
	db       *sql.DB
}

// Planted: accounts then ledger here, ledger then accounts below.
func (b *Bank) Forward() {
	b.accounts.Lock()
	defer b.accounts.Unlock()
	b.ledger.Lock()
	defer b.ledger.Unlock()
}

func (b *Bank) Backward() {
	b.ledger.Lock()
	defer b.ledger.Unlock()
	b.accounts.Lock()
	defer b.accounts.Unlock()
}

// Safe: the same order everywhere.
func (b *Bank) AlsoForward() {
	b.accounts.Lock()
	defer b.accounts.Unlock()
	b.ledger.Lock()
	defer b.ledger.Unlock()
}

// Planted: one query per id.
func (b *Bank) Totals(ids []int) int {
	total := 0
	for _, id := range ids {
		var n int
		b.db.QueryRow("select count(*) from orders where id = ?", id).Scan(&n)
		total += n
	}
	return total
}

// Planted: the file is never closed.
func readFirst(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, 10)
	f.Read(buf)
	return buf, nil
}

// Safe: deferred close.
func readFirstSafely(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	buf := make([]byte, 10)
	f.Read(buf)
	return buf, nil
}

// Planted: the response body is never closed, and the ticker never stopped.
func poll(url string) {
	resp, err := http.Get(url)
	if err != nil {
		return
	}
	_ = resp
	t := time.NewTicker(time.Second)
	<-t.C
}

// Planted: the password is logged.
func login(email string, password string) {
	log.Printf("login %s %s", email, password)
}

// Safe.
func loginSafely(email string) {
	log.Printf("login attempt %d", len(email))
}
