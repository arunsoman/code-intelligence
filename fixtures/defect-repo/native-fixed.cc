#include <atomic>
#include <thread>
std::atomic<int> shared_counter{0};
int main() {
  std::thread first([] { shared_counter.fetch_add(1); });
  std::thread second([] { shared_counter.fetch_add(1); });
  first.join(); second.join();
  return shared_counter.load() == 2 ? 0 : 1;
}
