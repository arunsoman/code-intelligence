package com.acme.pay;

public interface PaymentGateway {
    boolean authorize(String card, int amount);
}
