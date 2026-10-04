public class Deadlock {
    static final Object accounts = new Object();
    static final Object ledger = new Object();

    // Planted: the two threads take the locks in opposite orders, with a pause that makes the overlap certain.
    public static void main(String[] args) throws Exception {
        Thread a = new Thread(() -> { synchronized (accounts) { pause(); synchronized (ledger) { } } }, "forward");
        Thread b = new Thread(() -> { synchronized (ledger) { pause(); synchronized (accounts) { } } }, "backward");
        a.start(); b.start(); a.join(); b.join();
    }

    static void pause() { try { Thread.sleep(200); } catch (InterruptedException e) { } }
}
