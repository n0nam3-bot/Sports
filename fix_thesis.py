import re

p = 'src/lib/engine.ts'
s = open(p).read()
s = s.replace('favourite — fair price ${priceTag}.', 'favourite.')
s = s.replace('Fair price ${price > 0 ? "+" : ""}${price}.', '')
open(p, 'w').write(s)
print("Thesis fixed.")
