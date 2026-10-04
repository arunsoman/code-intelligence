#include <thread>
int shared_counter = 0;
int main() {
  std::thread first([] { shared_counter++; });
  std::thread second([] { shared_counter++; });
  first.join(); second.join();
  return 0;
}
