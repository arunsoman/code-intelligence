package com.example.payments.controller;

import com.example.payments.service.PaymentService;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/payments")
public class PaymentController {

    private final PaymentService payments;

    @Autowired
    public PaymentController(PaymentService payments) {
        this.payments = payments;
    }

    @PreAuthorize("hasAuthority('payments.write')")
    @PostMapping("/{userId}")
    public PaymentService.Payment create(@PathVariable Long userId, @RequestBody Long amount) {
        return payments.charge(userId, amount);
    }
}
