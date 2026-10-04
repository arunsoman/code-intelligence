package com.acme.shop;

import java.util.concurrent.locks.ReentrantLock;

public class Transfers {
    private final ReentrantLock accounts = new ReentrantLock();
    private final ReentrantLock ledger = new ReentrantLock();
    private final Object left = new Object();
    private final Object right = new Object();

    // Planted: accounts then ledger here, ledger then accounts below.
    public void forward() {
        accounts.lock();
        try {
            ledger.lock();
            try { audit(); } finally { ledger.unlock(); }
        } finally { accounts.unlock(); }
    }

    public void backward() {
        ledger.lock();
        try {
            accounts.lock();
            try { audit(); } finally { accounts.unlock(); }
        } finally { ledger.unlock(); }
    }

    // Safe: the same order everywhere.
    public void alsoForward() {
        accounts.lock();
        try {
            ledger.lock();
            try { audit(); } finally { ledger.unlock(); }
        } finally { accounts.unlock(); }
    }

    // Planted: synchronized blocks in opposite orders.
    public void leftRight() {
        synchronized (left) {
            synchronized (right) { audit(); }
        }
    }

    public void rightLeft() {
        synchronized (right) {
            synchronized (left) { audit(); }
        }
    }

    // Safe: a try-lock with a timeout gives up instead of waiting forever.
    public boolean polite() throws InterruptedException {
        if (ledger.tryLock(50, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            try {
                if (accounts.tryLock(50, java.util.concurrent.TimeUnit.MILLISECONDS)) {
                    try { audit(); } finally { accounts.unlock(); }
                }
            } finally { ledger.unlock(); }
        }
        return true;
    }

    private void audit() { }
}
