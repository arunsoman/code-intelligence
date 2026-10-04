package com.acme.pay;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class PaymentController {
    private final PaymentService paymentService;

    public PaymentController(PaymentService paymentService) {
        this.paymentService = paymentService;
    }

    @PostMapping("/payments")
    public String create(@RequestBody String body) {
        paymentService.charge("acct-1", 50);
        return audit(body);
    }

    @DeleteMapping("/accounts/{id}")
    public void remove(@PathVariable String id) {
        paymentService.close(id);
    }

    private String audit(String body) {
        System.out.println(body);
        return "ok";
    }
}
