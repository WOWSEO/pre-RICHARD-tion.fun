-- v54.7 — HANTA becomes the default coin, gets its logo
--
-- Reorders display_order so HANTA is first (= default landing page coin),
-- shifts TROLL/USDUC/BUTT down by one.  Sets HANTA's image_url to the
-- bundled /logos/hanta.jpg.  Idempotent — safe to re-run.

update supported_coins set display_order = 1, image_url = '/logos/hanta.jpg'
 where mint = '2tXpgu2DLTsPUf9zFmuZmA4xrYxXKBTpVq9wAM7hzs9y';

update supported_coins set display_order = 2
 where mint = '5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2';

update supported_coins set display_order = 3
 where mint = 'CB9dDufT3ZuQXqqSfa1c5kY935TEreyBw9XJXxHKpump';

update supported_coins set display_order = 4
 where mint = 'Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump';

-- Verify
select display_order, symbol, name, image_url
from supported_coins
order by display_order;
