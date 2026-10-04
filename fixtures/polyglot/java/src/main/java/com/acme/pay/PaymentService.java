package com.acme.pay;

import com.acme.ledger.LedgerService;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PaymentService {
    private final LedgerService ledger;
    private final KafkaTemplate<String, String> kafkaTemplate;
    private final PaymentGateway gateway;
    private int charged;

    public PaymentService(LedgerService ledger, KafkaTemplate<String, String> kafkaTemplate, PaymentGateway gateway) {
        this.gateway = gateway;
        this.ledger = ledger;
        this.kafkaTemplate = kafkaTemplate;
    }

    @Transactional
    public void charge(String account, int amount) {
        if (amount > 10000) {
            throw new FraudRejectedException(account);
        }
        gateway.authorize(account, amount);
        ledger.reserve(account, amount);
        this.charged = this.charged + amount;
        kafkaTemplate.send("payment.captured", account);
    }

    public void close(String id) {
        ledger.release(id);
    }
}
