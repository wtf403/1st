#!/usr/bin/env python3
"""Load test for simple-auth-server to demonstrate connection handling issues."""
import concurrent.futures
import time
import urllib.request
import urllib.error

def test_auth_check(worker_id: int) -> tuple[int, float, str]:
    """Single auth check request."""
    start = time.time()
    try:
        req = urllib.request.Request("http://127.0.0.1:18080/auth-check")
        with urllib.request.urlopen(req, timeout=5) as response:
            status = response.status
            duration = time.time() - start
            return (worker_id, duration, f"OK {status}")
    except urllib.error.HTTPError as e:
        duration = time.time() - start
        return (worker_id, duration, f"HTTP {e.code}")
    except Exception as e:
        duration = time.time() - start
        return (worker_id, duration, f"ERROR {type(e).__name__}")

def run_load_test(num_concurrent: int, num_requests: int):
    """Run load test with specified concurrency."""
    print(f"\n{'='*60}")
    print(f"Load Test: {num_concurrent} concurrent workers, {num_requests} requests each")
    print(f"{'='*60}")

    start_time = time.time()
    results = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=num_concurrent) as executor:
        futures = []
        for i in range(num_requests * num_concurrent):
            futures.append(executor.submit(test_auth_check, i))

        for future in concurrent.futures.as_completed(futures):
            results.append(future.result())

    total_time = time.time() - start_time

    # Analyze results
    durations = [r[1] for r in results]
    statuses = {}
    for r in results:
        status = r[2]
        statuses[status] = statuses.get(status, 0) + 1

    print(f"\nResults:")
    print(f"  Total requests: {len(results)}")
    print(f"  Total time: {total_time:.2f}s")
    print(f"  Requests/sec: {len(results)/total_time:.2f}")
    print(f"  Avg latency: {sum(durations)/len(durations)*1000:.2f}ms")
    print(f"  Min latency: {min(durations)*1000:.2f}ms")
    print(f"  Max latency: {max(durations)*1000:.2f}ms")
    print(f"\nStatus breakdown:")
    for status, count in sorted(statuses.items()):
        print(f"  {status}: {count}")

    # Check for failures
    errors = sum(1 for r in results if "ERROR" in r[2])
    if errors > 0:
        print(f"\n⚠️  {errors} requests failed!")

    return total_time, len(results), errors

if __name__ == "__main__":
    print("Starting load tests for simple-auth-server...")
    print("Make sure the server is running on http://127.0.0.1:18080")

    # Test 1: Low load (should work)
    run_load_test(num_concurrent=5, num_requests=10)
    time.sleep(1)

    # Test 2: Medium load (will show queueing)
    run_load_test(num_concurrent=20, num_requests=10)
    time.sleep(1)

    # Test 3: High load (will show failures/timeouts)
    run_load_test(num_concurrent=50, num_requests=10)
