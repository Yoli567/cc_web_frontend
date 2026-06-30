import asyncio
import random
import time
import uuid

MOCK_REPLIES_MESSAGE = [
    {
        "thinking": "用户在问编程的问题...让我想想怎么解释得更清楚。这个概念其实可以用一个比喻来说明。",
        "messages": [
            "这是一个很好的问题！",
            "简单来说，这个概念可以这样理解：它就像是给程序设定了一套规则。",
        ],
    },
    {
        "thinking": "用户想了解技术细节...我可以用一个具体的例子来说明。",
        "messages": [
            "你想了解哪个方面？前端还是后端？",
            "我可以给你一个具体的代码示例",
            "不过要注意，不同场景下实现方式会有差异",
        ],
    },
    {
        "thinking": None,
        "messages": [
            "嗯...让我想想",
            "我觉得可以这样处理",
        ],
    },
    {
        "thinking": "这个问题挺有意思的，让我从另一个角度来分析一下。可以结合实际场景来说明。",
        "messages": [
            "从另一个角度来看，这个问题其实可以分成两部分来考虑",
            "第一部分是...第二部分是...",
        ],
    },
]

MOCK_REPLIES_CABIN = [
    {
        "thinking": "用户想讨论一个开放性话题...让我组织一下思路，从几个不同的维度来分析。",
        "text": "这是个值得深入探讨的话题。\n\n首先，我们可以从技术角度来看——这个方案的优势在于它的灵活性和可扩展性。其次，从用户体验的角度，它提供了更直观的交互方式。\n\n当然，每种方案都有权衡。你觉得在你的使用场景里，哪个方面更重要？",
    },
    {
        "thinking": "让我把这个概念解释清楚...用一个具体的类比可能更容易理解。",
        "text": "你提到的这个概念，我试着用一个日常生活的类比来解释。\n\n想象你在整理一个书架。传统的方式是按字母顺序排列，但更高效的方式可能是按你使用频率来排列——最常用的放在最顺手的位置。\n\n这和我们讨论的原理是一样的：优化的关键不在于\"最标准\"，而在于\"最适合实际使用模式\"。",
    },
]

reply_index_msg = 0
reply_index_cabin = 0


async def generate_mock_reply(mode: str, user_text: str, callback):
    """Simulate CC replying. Calls `callback(event_dict)` for each event."""
    global reply_index_msg, reply_index_cabin

    # Simulate thinking delay
    await asyncio.sleep(0.8 + random.random() * 1.0)

    if mode == "message":
        reply = MOCK_REPLIES_MESSAGE[reply_index_msg % len(MOCK_REPLIES_MESSAGE)]
        reply_index_msg += 1

        # Send thinking event
        if reply["thinking"]:
            await callback({
                "type": "thinking",
                "thinking": reply["thinking"],
                "message_id": str(uuid.uuid4()),
                "timestamp": time.time(),
            })

        # Send typing indicator
        await callback({"type": "typing", "is_typing": True})

        # Send messages one by one with delays
        for i, msg_text in enumerate(reply["messages"]):
            await asyncio.sleep(0.8 + random.random() * 1.2)
            await callback({
                "type": "message",
                "role": "assistant",
                "text": msg_text,
                "message_id": str(uuid.uuid4()),
                "timestamp": time.time(),
                "has_thinking": i == 0 and reply["thinking"] is not None,
                "thinking": reply["thinking"] if i == 0 else None,
            })

        await callback({"type": "typing", "is_typing": False})
        await callback({"type": "turn_complete"})

    elif mode == "cabin":
        reply = MOCK_REPLIES_CABIN[reply_index_cabin % len(MOCK_REPLIES_CABIN)]
        reply_index_cabin += 1

        msg_id = str(uuid.uuid4())

        # Send thinking
        if reply["thinking"]:
            await callback({
                "type": "thinking",
                "thinking": reply["thinking"],
                "message_id": msg_id,
                "timestamp": time.time(),
            })

        # Stream text character by character (in chunks)
        text = reply["text"]
        await callback({
            "type": "stream_start",
            "message_id": msg_id,
            "timestamp": time.time(),
        })

        pos = 0
        while pos < len(text):
            chunk_size = random.randint(1, 4)
            chunk = text[pos : pos + chunk_size]
            pos += chunk_size
            await callback({
                "type": "stream_chunk",
                "message_id": msg_id,
                "chunk": chunk,
            })
            await asyncio.sleep(0.02 + random.random() * 0.04)

        await callback({
            "type": "stream_end",
            "message_id": msg_id,
            "timestamp": time.time(),
        })
        await callback({"type": "turn_complete"})
