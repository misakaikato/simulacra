"""Mesa counterpart of simulacra's cohort echo-chamber bench.

Same model as examples/echo_chamber/cohort.yaml: N agents on a random graph with mean
degree 8, stance in [-2, 2], stubbornness in [0, 1]; each step 50% of agents activate,
an activated agent "posts" when its stance is above 0, and every agent whose posting
neighbors exist moves toward the mean stance of those neighbors:
stance += rate * (1 - stubbornness) * (neighborMean - stance), rate = 0.2.
No persistence, no event log: this measures the ABM kernel only.
"""

import random
import sys
import time

import mesa


class Person(mesa.Agent):
    def __init__(self, model, stance, stubbornness):
        super().__init__(model)
        self.stance = stance
        self.stubbornness = stubbornness
        self.neighbors = []
        self.posted = False
        self.next_stance = stance

    def decide(self):
        self.posted = self.model.random.random() < 0.5 and self.stance > 0

    def update(self):
        total = 0.0
        count = 0
        for n in self.neighbors:
            if n.posted:
                total += n.stance
                count += 1
        if count:
            mean = total / count
            self.next_stance = self.stance + 0.2 * (1 - self.stubbornness) * (mean - self.stance)
        else:
            self.next_stance = self.stance

    def commit(self):
        self.stance = self.next_stance


class EchoModel(mesa.Model):
    def __init__(self, n, seed):
        super().__init__(seed=seed)
        rng = self.random
        agents = [Person(self, rng.uniform(-2, 2), rng.uniform(0, 1)) for _ in range(n)]
        edges = n * 4  # mean degree 8
        for _ in range(edges):
            a = agents[rng.randrange(n)]
            b = agents[rng.randrange(n)]
            if a is not b:
                a.neighbors.append(b)
                b.neighbors.append(a)

    def step(self):
        self.agents.do("decide")
        self.agents.do("update")
        self.agents.do("commit")


def run(n, ticks, seed=7):
    t0 = time.perf_counter()
    model = EchoModel(n, seed)
    t1 = time.perf_counter()
    for _ in range(ticks):
        model.step()
    t2 = time.perf_counter()
    mean = sum(a.stance for a in model.agents) / n
    return t1 - t0, t2 - t1, mean


if __name__ == "__main__":
    print(f"mesa {mesa.__version__}, python {sys.version.split()[0]}")
    for n in (1_000, 100_000):
        setup, steps, mean = run(n, 20)
        print(f"| mesa {n:>6} agents | 20 ticks | setup {setup:6.2f} s | steps {steps:6.2f} s | total {setup + steps:6.2f} s | mean stance {mean:.4f} |")
