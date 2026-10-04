package com.acme.shop;

import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
public class OrderController {
    private final OrderRepository orderRepository;

    public OrderController(OrderRepository orderRepository) {
        this.orderRepository = orderRepository;
    }

    // Planted: anyone can delete an order.
    @DeleteMapping("/orders/{id}")
    public void remove(@PathVariable Long id) {
        orderRepository.deleteById(id);
    }

    // Safe: a role is required.
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/orders")
    public void create(@RequestBody String body) {
        orderRepository.save(body);
    }

    // Safe: reads only.
    @GetMapping("/orders/{id}")
    public Object show(@PathVariable Long id) {
        return orderRepository.findById(id);
    }
}
