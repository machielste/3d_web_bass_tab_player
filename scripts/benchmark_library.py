"""Measure local catalog HTTP latency; run while Tab Player is running."""
import argparse
import json
import statistics
import time
from urllib.parse import urlencode
from urllib.request import urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8765')
    parser.add_argument('--samples', type=int, default=20)
    args = parser.parse_args()

    def get(route):
        with urlopen(args.url.rstrip('/') + '/api/library/' + route, timeout=15) as response:
            return json.load(response)

    def measure(route):
        samples = []
        for _ in range(max(1, min(100, args.samples))):
            started = time.perf_counter()
            get(route)
            samples.append((time.perf_counter() - started) * 1000)
        return dict(median_ms=round(statistics.median(samples), 2), p95_ms=round(sorted(samples)[int((len(samples) - 1) * .95)], 2))

    first = get('songs')
    last_page = measure('songs?' + urlencode({'snapshot': first['snapshot'], 'offset': max(0, first['total'] - 100)}))
    result = dict(status=get('status'), last_page=last_page, catalog=measure('songs'),
                  search=measure('songs?' + urlencode({'q': 'love'})))
    # Keep local folder paths out of the benchmark output.
    result['status'].pop('roots', None)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
