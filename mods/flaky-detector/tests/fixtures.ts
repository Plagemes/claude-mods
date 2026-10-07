// Real output of vitest 3.2 (default and verbose reporters), jest 29 (default and --verbose), pytest 9 (default and -v),
// go 1.24 test (plain and -v), cargo 1.97 test (backtrace trimmed) and rspec 3.13 on small suites with failing tests.

export const VITEST_FAIL = "\n RUN  v3.2.7 /home/dev/tests-js\n\n \u276f src/math.test.js (4 tests | 2 failed) 11ms\n   \u2713 math > adds 2ms\n   \u00d7 math > divides by zero 7ms\n     \u2192 expected Infinity to be +0 // Object.is equality\n   \u2713 math > nested > multiplies 0ms\n   \u00d7 top level fails 1ms\n     \u2192 expected 'a' to be 'b' // Object.is equality\n \u2713 src/clock.test.js (1 test) 2ms\n\n\u23af\u23af\u23af\u23af\u23af\u23af\u23af Failed Tests 2 \u23af\u23af\u23af\u23af\u23af\u23af\u23af\n\n FAIL  src/math.test.js > math > divides by zero\nAssertionError: expected Infinity to be +0 // Object.is equality\n\n\u001b[32m- Expected\u001b[39m\n\u001b[31m+ Received\u001b[39m\n\n\u001b[32m- 0\u001b[39m\n\u001b[31m+ Infinity\u001b[39m\n\n \u276f src/math.test.js:4:47\n      2| describe('math', () => {\n      3|   it('adds', () => { expect(1 + 1).toBe(2) })\n      4|   it('divides by zero', () => { expect(1 / 0).toBe(0) })\n       |                                               ^\n      5|   describe('nested', () => { it('multiplies', () => { expect(2 * 3).to\u2026\n      6| })\n\n\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[1/2]\u23af\n\n FAIL  src/math.test.js > top level fails\nAssertionError: expected 'a' to be 'b' // Object.is equality\n\nExpected: \u001b[32m\"b\"\u001b[39m\nReceived: \u001b[31m\"a\"\u001b[39m\n\n \u276f src/math.test.js:7:45\n      5|   describe('nested', () => { it('multiplies', () => { expect(2 * 3).to\u2026\n      6| })\n      7| test('top level fails', () => { expect('a').toBe('b') })\n       |                                             ^\n      8| \n\n\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[2/2]\u23af\n\n\n Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 3 passed (5)\n   Start at  16:01:28\n   Duration  345ms (transform 37ms, setup 0ms, collect 33ms, tests 14ms, environment 0ms, prepare 155ms)\n\n"

export const VITEST_VERBOSE = "\n RUN  v3.2.7 /home/dev/tests-js\n\n \u2713 src/math.test.js > math > adds 1ms\n \u00d7 src/math.test.js > math > divides by zero 7ms\n   \u2192 expected Infinity to be +0 // Object.is equality\n \u2713 src/math.test.js > math > nested > multiplies 0ms\n \u00d7 src/math.test.js > top level fails 1ms\n   \u2192 expected 'a' to be 'b' // Object.is equality\n \u2713 src/clock.test.js > ticks 1ms\n\n\u23af\u23af\u23af\u23af\u23af\u23af\u23af Failed Tests 2 \u23af\u23af\u23af\u23af\u23af\u23af\u23af\n\n FAIL  src/math.test.js > math > divides by zero\nAssertionError: expected Infinity to be +0 // Object.is equality\n\n\u001b[32m- Expected\u001b[39m\n\u001b[31m+ Received\u001b[39m\n\n\u001b[32m- 0\u001b[39m\n\u001b[31m+ Infinity\u001b[39m\n\n \u276f src/math.test.js:4:47\n      2| describe('math', () => {\n      3|   it('adds', () => { expect(1 + 1).toBe(2) })\n      4|   it('divides by zero', () => { expect(1 / 0).toBe(0) })\n       |                                               ^\n      5|   describe('nested', () => { it('multiplies', () => { expect(2 * 3).to\u2026\n      6| })\n\n\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[1/2]\u23af\n\n FAIL  src/math.test.js > top level fails\nAssertionError: expected 'a' to be 'b' // Object.is equality\n\nExpected: \u001b[32m\"b\"\u001b[39m\nReceived: \u001b[31m\"a\"\u001b[39m\n\n \u276f src/math.test.js:7:45\n      5|   describe('nested', () => { it('multiplies', () => { expect(2 * 3).to\u2026\n      6| })\n      7| test('top level fails', () => { expect('a').toBe('b') })\n       |                                             ^\n      8| \n\n\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[2/2]\u23af\n\n\n Test Files  1 failed | 1 passed (2)\n      Tests  2 failed | 3 passed (5)\n   Start at  16:01:29\n   Duration  318ms (transform 21ms, setup 0ms, collect 22ms, tests 13ms, environment 0ms, prepare 129ms)\n\n"

export const JEST_FAIL = String.raw`PASS jest/util.test.js
FAIL jest/cart.test.js
  ● cart › applies discount

    expect(received).toBe(expected) // Object.is equality

    Expected: 80
    Received: 90

      1 | describe('cart', () => {
      2 |   test('adds items', () => { expect([1].length).toBe(1) })
    > 3 |   test('applies discount', () => { expect(90).toBe(80) })
        |                                               ^
      4 |   describe('checkout', () => { it('charges card', () => { expect(true).toBe(false) }) })
      5 | })
      6 |

      at Object.toBe (jest/cart.test.js:3:47)

  ● cart › checkout › charges card

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      2 |   test('adds items', () => { expect([1].length).toBe(1) })
      3 |   test('applies discount', () => { expect(90).toBe(80) })
    > 4 |   describe('checkout', () => { it('charges card', () => { expect(true).toBe(false) }) })
        |                                                                        ^
      5 | })
      6 |

      at Object.toBe (jest/cart.test.js:4:72)

Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 2 passed, 4 total
Snapshots:   0 total
Time:        0.656 s
Ran all test suites matching /jest/i.
`

export const JEST_VERBOSE = String.raw`FAIL jest/cart.test.js
  cart
    ✓ adds items (1 ms)
    ✕ applies discount (2 ms)
    checkout
      ✕ charges card

  ● cart › applies discount

    expect(received).toBe(expected) // Object.is equality

    Expected: 80
    Received: 90

      1 | describe('cart', () => {
      2 |   test('adds items', () => { expect([1].length).toBe(1) })
    > 3 |   test('applies discount', () => { expect(90).toBe(80) })
        |                                               ^
      4 |   describe('checkout', () => { it('charges card', () => { expect(true).toBe(false) }) })
      5 | })
      6 |

      at Object.toBe (jest/cart.test.js:3:47)

  ● cart › checkout › charges card

    expect(received).toBe(expected) // Object.is equality

    Expected: false
    Received: true

      2 |   test('adds items', () => { expect([1].length).toBe(1) })
      3 |   test('applies discount', () => { expect(90).toBe(80) })
    > 4 |   describe('checkout', () => { it('charges card', () => { expect(true).toBe(false) }) })
        |                                                                        ^
      5 | })
      6 |

      at Object.toBe (jest/cart.test.js:4:72)

PASS jest/util.test.js
  ✓ formats

Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 2 passed, 4 total
Snapshots:   0 total
Time:        0.295 s, estimated 1 s
Ran all test suites matching /jest/i.
`

export const PYTEST_FAIL = String.raw`============================= test session starts ==============================
platform linux -- Python 3.13.16, pytest-9.1.1, pluggy-1.6.0
benchmark: 5.3.0 (defaults: timer=time.perf_counter disable_gc=False min_rounds=5 min_time=0.000005 max_time=1.0 calibration_precision=10 warmup=False warmup_iterations=100000)
rootdir: /home/dev/tests-py
plugins: benchmark-5.3.0
collected 7 items

test_other.py .                                                          [ 14%]
test_shop.py .F.FF.                                                      [100%]

=================================== FAILURES ===================================
___________________________________ test_tax ___________________________________

    def test_tax():
>       assert round(0.1 + 0.2, 2) == 0.31
E       assert 0.3 == 0.31
E        +  where 0.3 = round((0.1 + 0.2), 2)

test_shop.py:7: AssertionError
_____________________________ TestCart.test_remove _____________________________

self = <test_shop.TestCart object at 0x7f2841cdb610>

    def test_remove(self):
>       raise KeyError("sku-1")
E       KeyError: 'sku-1'

test_shop.py:13: KeyError
_________________________________ test_even[1] _________________________________

n = 1

    @pytest.mark.parametrize("n", [1, 2])
    def test_even(n):
>       assert n % 2 == 0
E       assert (1 % 2) == 0

test_shop.py:17: AssertionError
=========================== short test summary info ============================
FAILED test_shop.py::test_tax - assert 0.3 == 0.31
FAILED test_shop.py::TestCart::test_remove - KeyError: 'sku-1'
FAILED test_shop.py::test_even[1] - assert (1 % 2) == 0
========================= 3 failed, 4 passed in 0.04s ==========================
`

export const PYTEST_VERBOSE = String.raw`============================= test session starts ==============================
platform linux -- Python 3.13.16, pytest-9.1.1, pluggy-1.6.0 -- /home/dev/tests-py/../bench-py/.venv/bin/python
cachedir: .pytest_cache
benchmark: 5.3.0 (defaults: timer=time.perf_counter disable_gc=False min_rounds=5 min_time=0.000005 max_time=1.0 calibration_precision=10 warmup=False warmup_iterations=100000)
rootdir: /home/dev/tests-py
plugins: benchmark-5.3.0
collecting ... collected 7 items

test_other.py::test_ok PASSED                                            [ 14%]
test_shop.py::test_total PASSED                                          [ 28%]
test_shop.py::test_tax FAILED                                            [ 42%]
test_shop.py::TestCart::test_empty PASSED                                [ 57%]
test_shop.py::TestCart::test_remove FAILED                               [ 71%]
test_shop.py::test_even[1] FAILED                                        [ 85%]
test_shop.py::test_even[2] PASSED                                        [100%]

=================================== FAILURES ===================================
___________________________________ test_tax ___________________________________

    def test_tax():
>       assert round(0.1 + 0.2, 2) == 0.31
E       assert 0.3 == 0.31
E        +  where 0.3 = round((0.1 + 0.2), 2)

test_shop.py:7: AssertionError
_____________________________ TestCart.test_remove _____________________________

self = <test_shop.TestCart object at 0x7f371be53610>

    def test_remove(self):
>       raise KeyError("sku-1")
E       KeyError: 'sku-1'

test_shop.py:13: KeyError
_________________________________ test_even[1] _________________________________

n = 1

    @pytest.mark.parametrize("n", [1, 2])
    def test_even(n):
>       assert n % 2 == 0
E       assert (1 % 2) == 0

test_shop.py:17: AssertionError
=========================== short test summary info ============================
FAILED test_shop.py::test_tax - assert 0.3 == 0.31
FAILED test_shop.py::TestCart::test_remove - KeyError: 'sku-1'
FAILED test_shop.py::test_even[1] - assert (1 % 2) == 0
========================= 3 failed, 4 passed in 0.03s ==========================
`

export const GO_FAIL = String.raw`--- FAIL: TestDiv (0.00s)
    calc_test.go:6: expected 2, got 3
--- FAIL: TestTable (0.00s)
    --- FAIL: TestTable/large (0.00s)
        calc_test.go:9: overflow
FAIL
FAIL	example.com/shop/calc	0.006s
ok  	example.com/shop/store	0.002s
FAIL
`

export const GO_VERBOSE = String.raw`=== RUN   TestAdd
--- PASS: TestAdd (0.00s)
=== RUN   TestDiv
    calc_test.go:6: expected 2, got 3
--- FAIL: TestDiv (0.00s)
=== RUN   TestTable
=== RUN   TestTable/small
=== RUN   TestTable/large
    calc_test.go:9: overflow
--- FAIL: TestTable (0.00s)
    --- PASS: TestTable/small (0.00s)
    --- FAIL: TestTable/large (0.00s)
FAIL
FAIL	example.com/shop/calc	0.002s
=== RUN   TestSave
--- PASS: TestSave (0.00s)
PASS
ok  	example.com/shop/store	0.002s
FAIL
`

export const CARGO_FAIL = "    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.22s\n     Running unittests src/lib.rs (target/debug/deps/shop-71db388100e3267b)\n\nrunning 3 tests\ntest tests::slow_one ... ignored\ntest tests::it_adds ... ok\ntest tests::it_fails ... FAILED\n\nfailures:\n\n---- tests::it_fails stdout ----\n\nthread 'tests::it_fails' (32572) panicked at src/lib.rs:9:21:\nassertion `left == right` failed: math is hard\n  left: 4\n right: 5\n\n\nfailures:\n    tests::it_fails\n\ntest result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.09s\n\nerror: test failed, to rerun pass `--lib`\n"

export const RSPEC_FAIL = ".FF\n\nFailures:\n\n  1) User rejects blank names\n     Failure/Error: expect(\"\").not_to be_empty\n       expected `\"\".empty?` to be falsey, got true\n     # ./spec/models/user_spec.rb:6:in `block (2 levels) in <top (required)>'\n\n  2) User when admin can delete posts\n     Failure/Error: expect(1).to eq(2)\n\n       expected: 2\n            got: 1\n\n       (compared using ==)\n     # ./spec/models/user_spec.rb:10:in `block (3 levels) in <top (required)>'\n\nFinished in 0.00998 seconds (files took 0.07595 seconds to load)\n3 examples, 2 failures\n\nFailed examples:\n\nrspec ./spec/models/user_spec.rb:5 # User rejects blank names\nrspec ./spec/models/user_spec.rb:9 # User when admin can delete posts\n\n"

