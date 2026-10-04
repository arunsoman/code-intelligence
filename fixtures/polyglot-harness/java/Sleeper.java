public class Sleeper {
    // Never finishes, but no thread is deadlocked: it is only waiting.
    public static void main(String[] args) throws Exception {
        Thread.sleep(600_000);
    }
}
