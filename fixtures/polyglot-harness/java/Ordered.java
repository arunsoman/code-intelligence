public class Ordered {
    static final Object accounts = new Object();
    static final Object ledger = new Object();

    // Safe: both threads take accounts then ledger.
    public static void main(String[] args) throws Exception {
        Runnable r = () -> { synchronized (accounts) { pause(); synchronized (ledger) { } } };
        Thread a = new Thread(r, "one"), b = new Thread(r, "two");
        a.start(); b.start(); a.join(); b.join();
    }

    static void pause() { try { Thread.sleep(50); } catch (InterruptedException e) { } }
}
