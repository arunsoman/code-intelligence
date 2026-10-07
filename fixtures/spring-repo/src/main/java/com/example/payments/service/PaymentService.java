package com.example.payments.service;

import com.example.payments.repository.UserRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PaymentService {

    private final UserRepository users;

    @Autowired
    public PaymentService(UserRepository users) {
        this.users = users;
    }

    @Transactional
    public Payment charge(Long userId, Long amount) {
        User user = users.findById(userId);
        return new Payment(user, amount);
    }

    public static class Payment {
        private final User user;
        private final Long amount;

        public Payment(User user, Long amount) {
            this.user = user;
            this.amount = amount;
        }
    }
}
