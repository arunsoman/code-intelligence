package main

import (
	"fmt"
	"net/http"

	"example.com/app/internal/ledger"
)

type Server struct {
	led *ledger.Ledger
}

func (s *Server) Handle(amount int) {
	s.led.Reserve(amount)
	fmt.Println(ledger.Round(amount))
}

func chargeHandler(w http.ResponseWriter, r *http.Request) {
	fmt.Println("charge")
}

func main() {
	http.HandleFunc("/charge", chargeHandler)
	http.HandleFunc("/ghost", missingHandler)
	s := &Server{}
	s.Handle(3)
	handlers := map[string]func(){}
	handlers["x"]()
}
