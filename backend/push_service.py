from __future__ import annotations

import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any


class PushService:
    def __init__(self, storage_path: Path):
        self.storage_path = storage_path
        self.vapid_public_key = os.getenv("CC_WEB_PUSH_VAPID_PUBLIC_KEY", "").strip()
        self.vapid_private_key = os.getenv("CC_WEB_PUSH_VAPID_PRIVATE_KEY", "").strip()
        self.vapid_subject = os.getenv("CC_WEB_PUSH_VAPID_SUBJECT", "mailto:admin@example.com").strip()
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.vapid_public_key and self.vapid_private_key)

    async def list_subscriptions(self) -> list[dict[str, Any]]:
        async with self._lock:
            return self._load()

    async def save_subscription(self, subscription: dict[str, Any]) -> dict[str, Any]:
        endpoint = subscription.get("endpoint")
        keys = subscription.get("keys")
        if not isinstance(endpoint, str) or not endpoint:
            raise ValueError("missing push endpoint")
        if not isinstance(keys, dict) or not isinstance(keys.get("p256dh"), str) or not isinstance(keys.get("auth"), str):
            raise ValueError("missing push keys")

        item = {
            "endpoint": endpoint,
            "expirationTime": subscription.get("expirationTime"),
            "keys": {
                "p256dh": keys["p256dh"],
                "auth": keys["auth"],
            },
            "created_at": time.time(),
            "updated_at": time.time(),
        }
        async with self._lock:
            subscriptions = self._load()
            existing = next((idx for idx, sub in enumerate(subscriptions) if sub.get("endpoint") == endpoint), -1)
            if existing >= 0:
                item["created_at"] = subscriptions[existing].get("created_at") or item["created_at"]
                subscriptions[existing] = item
            else:
                subscriptions.append(item)
            self._save(subscriptions)
        return item

    async def remove_subscription(self, endpoint: str) -> int:
        if not endpoint:
            return 0
        async with self._lock:
            subscriptions = self._load()
            next_subscriptions = [sub for sub in subscriptions if sub.get("endpoint") != endpoint]
            removed = len(subscriptions) - len(next_subscriptions)
            if removed:
                self._save(next_subscriptions)
            return removed

    async def send_notification(
        self,
        title: str,
        body: str = "",
        url: str = "/activity",
        tag: str = "cc-nudge",
        suppress_if_visible: bool = False,
    ) -> dict[str, int]:
        if not self.configured:
            return {"sent": 0, "failed": 0, "removed": 0}

        subscriptions = await self.list_subscriptions()
        if not subscriptions:
            return {"sent": 0, "failed": 0, "removed": 0}

        payload = json.dumps({
            "title": title,
            "body": body,
            "url": url,
            "tag": tag,
            "suppressIfVisible": suppress_if_visible,
        }, ensure_ascii=False)

        sent = 0
        failed = 0
        stale_endpoints: list[str] = []
        for subscription in subscriptions:
            status_code = None
            last_exc: Exception | None = None
            # 404/410 mean the subscription is gone — don't retry. Anything else
            # (network blips, FCM 429/5xx) is transient, so try once more.
            for attempt in range(2):
                try:
                    await asyncio.to_thread(self._send_one, subscription, payload)
                    sent += 1
                    last_exc = None
                    break
                except Exception as exc:
                    last_exc = exc
                    status_code = getattr(getattr(exc, "response", None), "status_code", None)
                    if status_code in {404, 410} or attempt == 1:
                        break
                    await asyncio.sleep(1)
            if last_exc is not None:
                failed += 1
                print(f"[push] send failed tag={tag} status={status_code} err={type(last_exc).__name__}: {last_exc}", flush=True)
                if status_code in {404, 410}:
                    endpoint = subscription.get("endpoint")
                    if isinstance(endpoint, str):
                        stale_endpoints.append(endpoint)

        removed = 0
        for endpoint in stale_endpoints:
            removed += await self.remove_subscription(endpoint)
        print(f"[push] send tag={tag} suppress={suppress_if_visible} sent={sent} failed={failed} removed={removed}", flush=True)
        return {"sent": sent, "failed": failed, "removed": removed}

    def _send_one(self, subscription: dict[str, Any], payload: str) -> None:
        from pywebpush import webpush

        subscription_info = {
            "endpoint": subscription.get("endpoint"),
            "expirationTime": subscription.get("expirationTime"),
            "keys": subscription.get("keys"),
        }
        webpush(
            subscription_info=subscription_info,
            data=payload,
            vapid_private_key=self.vapid_private_key,
            vapid_claims={"sub": self.vapid_subject},
            ttl=86400,
            headers={"Urgency": "high"},
        )

    def _load(self) -> list[dict[str, Any]]:
        try:
            raw = json.loads(self.storage_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return []
        if not isinstance(raw, list):
            return []
        return [item for item in raw if isinstance(item, dict) and isinstance(item.get("endpoint"), str)]

    def _save(self, subscriptions: list[dict[str, Any]]) -> None:
        self.storage_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.storage_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(subscriptions, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.storage_path)
