package com.acme.pay;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class CaptureListener {
    @KafkaListener(topics = "payment.captured")
    public void onCaptured(String account) {
        System.out.println("captured " + account);
    }
}
