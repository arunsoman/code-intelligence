package main

import "net/http"

type Store struct{ lastDeleted string }

func (s *Store) Delete(id string) { s.lastDeleted = id }

var store = &Store{}

// Planted: anyone can delete.
func deleteHandler(w http.ResponseWriter, r *http.Request) {
	store.Delete(r.URL.Query().Get("id"))
}

// Safe: registered behind requireAuth below.
func adminDeleteHandler(w http.ResponseWriter, r *http.Request) {
	store.Delete(r.URL.Query().Get("id"))
}

func requireAuth(next http.HandlerFunc) http.HandlerFunc { return next }

func routes() {
	http.HandleFunc("/delete", deleteHandler)
	http.HandleFunc("/admin/delete", requireAuth(adminDeleteHandler))
}
