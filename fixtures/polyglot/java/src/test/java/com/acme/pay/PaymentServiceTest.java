package com.acme.pay;

import org.junit.jupiter.api.Test;

class PaymentServiceTest {
    private PaymentService service;

    @Test
    void chargesAnAccount() {
        service.charge("acct-1", 5);
    }
}
