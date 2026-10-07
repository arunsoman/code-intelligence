package com.example.payments.repository;

import org.springframework.stereotype.Repository;
import com.example.payments.service.User;

@Repository
public class UserRepository {
    public User findById(Long id) {
        return new User(id, "alice");
    }
}
