"""Token-to-USD pricing for budget enforcement.

BudgetGuard does not need pricing to be useful: token and call budgets work with
zero configuration. Pricing is only required when a policy sets `max_usd`.

The built-in table is ILLUSTRATIVE and will drift. Do not trust it for billing.
Pass your own verified prices (per 1,000 tokens) for anything that matters:

    pricing = Pricing({"my-model": ModelPrice(input_per_1k=0.003, output_per_1k=0.015)})
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional


@dataclass(frozen=True)
class ModelPrice:
    """USD per 1,000 tokens."""

    input_per_1k: float
    output_per_1k: float

    def __post_init__(self) -> None:
        if self.input_per_1k < 0 or self.output_per_1k < 0:
            raise ValueError("prices must be non-negative")


# Illustrative only. Verify against the provider's current pricing page before
# relying on USD budgets. Kept deliberately small; supply your own table.
DEFAULT_PRICES: Dict[str, ModelPrice] = {
    "claude-opus-4-8": ModelPrice(15.0 / 1000, 75.0 / 1000),
    "claude-sonnet-4-6": ModelPrice(3.0 / 1000, 15.0 / 1000),
    "claude-haiku-4-5": ModelPrice(1.0 / 1000, 5.0 / 1000),
}


class Pricing:
    """Resolves a model name + token counts to a USD cost."""

    def __init__(
        self,
        prices: Optional[Dict[str, ModelPrice]] = None,
        *,
        default: Optional[ModelPrice] = None,
        use_builtin: bool = True,
    ):
        self._prices: Dict[str, ModelPrice] = dict(DEFAULT_PRICES) if use_builtin else {}
        if prices:
            self._prices.update(prices)
        self._default = default

    def has(self, model: Optional[str]) -> bool:
        return (model in self._prices) or (self._default is not None)

    def cost(self, model: Optional[str], input_tokens: int, output_tokens: int) -> float:
        mp = self._prices.get(model or "") or self._default
        if mp is None:
            raise KeyError(
                f"no price for model {model!r}. Add it, set a default ModelPrice, "
                f"or use a token budget instead of max_usd."
            )
        return (input_tokens / 1000.0) * mp.input_per_1k + (output_tokens / 1000.0) * mp.output_per_1k
