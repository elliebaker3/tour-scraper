run the end-to-end demo:
  (python3 tests/mock_racecenter.py 8765 &)
  export PYTHONPATH=src TOUR_BASE_URL=http://127.0.0.1:8765
  python3 -m tourscraper probe && python3 -m tourscraper bootstrap && python3 -m tourscraper profiles
  python3 -m tourscraper live --stage 14 --max-hours 0.003
