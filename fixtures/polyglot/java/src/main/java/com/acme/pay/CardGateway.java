package com.acme.pay;

import org.springframework.stereotype.Component;

@Component
public class CardGateway implements PaymentGateway {
    @Override
    public boolean authorize(String card, int amount) {
        return amount < 100000;
    }
}
