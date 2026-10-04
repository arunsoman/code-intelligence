package com.acme.shop;

import java.io.BufferedReader;
import java.io.FileReader;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.client.RestTemplate;

public class OrderService {
    private static final Logger log = LoggerFactory.getLogger(OrderService.class);
    private final OrderRepository orderRepository;
    private final RestTemplate restTemplate;
    private final ReentrantLock gate = new ReentrantLock();

    public OrderService(OrderRepository orderRepository, RestTemplate restTemplate) {
        this.orderRepository = orderRepository;
        this.restTemplate = restTemplate;
    }

    // Planted: one query per id.
    public int totalOf(List<Long> ids) {
        int total = 0;
        for (Long id : ids) {
            total += orderRepository.findById(id).size();
        }
        return total;
    }

    // Safe: one query for all of them.
    public int totalBatch(List<Long> ids) {
        return orderRepository.findAllById(ids).size();
    }

    // Planted: a network call while holding the monitor.
    public synchronized String quote(String sku) {
        return restTemplate.getForObject("http://pricing/" + sku, String.class);
    }

    // Planted: the stream is never closed.
    public String firstLine(String path) throws Exception {
        BufferedReader reader = new BufferedReader(new FileReader(path));
        return reader.readLine();
    }

    // Safe: try-with-resources closes it.
    public String firstLineSafely(String path) throws Exception {
        try (BufferedReader reader = new BufferedReader(new FileReader(path))) {
            return reader.readLine();
        }
    }

    // Planted: unlocked on the normal path only.
    public void guarded() {
        gate.lock();
        compute();
        gate.unlock();
    }

    // Safe: unlock in finally.
    public void guardedSafely() {
        gate.lock();
        try { compute(); } finally { gate.unlock(); }
    }

    // Planted: a pool nobody shuts down.
    public void fireAndForget(Runnable r) {
        ExecutorService pool = Executors.newFixedThreadPool(4);
        pool.submit(r);
    }

    // Planted: the password and email are logged.
    public void login(String email, String password) {
        log.info("login attempt {} {}", email, password);
    }

    // Safe: constants and a masked value.
    public void loginMasked(String email) {
        log.info("login attempt {}", mask(email));
    }

    private String mask(String s) { return "***"; }
    private void compute() { }
}
