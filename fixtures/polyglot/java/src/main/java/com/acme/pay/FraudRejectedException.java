package com.acme.pay;

public class FraudRejectedException extends RuntimeException {
    public FraudRejectedException(String account) { super(account); }
}
