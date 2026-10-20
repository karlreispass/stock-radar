"""Rules shared by daily alerts. Match analysis.js without looking ahead."""
import math


def moving_average(history, index, period=20):
    if index < period - 1:
        return None
    return sum(point["close"] for point in history[index - period + 1:index + 1]) / period


def is_candidate(history, index):
    if index < 20:
        return False
    latest, baseline = history[index], history[index - 5]
    if latest["rsi"] is None or baseline["rsi"] is None:
        return False
    recently_low = any(point["rsi"] is not None and point["rsi"] < 40 for point in history[index - 4:index + 1])
    return (
        recently_low and latest["rsi"] > baseline["rsi"]
        and latest["close"] > moving_average(history, index)
        and history[index - 1]["close"] <= moving_average(history, index - 1)
    )


def validate_settings(settings):
    if not isinstance(settings, dict) or set(settings) != {"targets", "events", "health_alerts", "backtest"}:
        raise ValueError("Seadistus peab sisaldama targets, events, health_alerts ja backtest välju.")
    targets = settings["targets"]
    if not isinstance(targets, dict) or set(targets) != {"KO", "PEP", "JNJ", "PG", "CL"}:
        raise ValueError("Sihthinnad peavad sisaldama viit jälgitavat aktsiat.")
    for target in targets.values():
        if target is not None and (type(target) not in (int, float) or not math.isfinite(target) or target <= 0):
            raise ValueError("Sihthind peab olema positiivne arv või null.")
    events = settings["events"]
    if not isinstance(events, dict) or set(events) != {"watch", "candidate", "target", "oversold", "recovery"} or any(type(value) is not bool for value in events.values()):
        raise ValueError("Teavituste valikud peavad olema tõeväärtused.")
    if type(settings["health_alerts"]) is not bool:
        raise ValueError("health_alerts peab olema tõeväärtus.")
    backtest = settings["backtest"]
    if not isinstance(backtest, dict) or set(backtest) != {"fee_bps", "monthly_contribution"}:
        raise ValueError("Ajaloolise võrdluse seadistus puudub.")
    for key, value in backtest.items():
        if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
            raise ValueError("Ajaloolise võrdluse väärtus ei sobi.")
    if backtest["fee_bps"] > 500 or not 0 < backtest["monthly_contribution"] <= 1000000:
        raise ValueError("Kulu peab olema 0–500 baaspunkti ja kuumakse kuni 1 000 000 USD.")
    return settings
