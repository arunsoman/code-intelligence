package com.acme.shop;

import java.util.List;

public interface OrderRepository {
    List<String> findById(Long id);
    List<String> findAllById(List<Long> ids);
    void deleteById(Long id);
    void save(String order);
}
