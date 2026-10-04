package com.acme.ledger;

import org.springframework.stereotype.Service;

@Service
public class LedgerService {
    private long balance;

    public void reserve(String account, int amount) {
        this.balance -= amount;
        record(account);
    }

    public void release(String account) {
        record(account);
    }

    private void record(String account) { }
}
