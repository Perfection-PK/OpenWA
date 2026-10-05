# Receiving OpenWA "Save Lead" Webhooks in Laravel

This guide sets up a Laravel endpoint that receives the `lead.saved` webhook from OpenWA and stores the lead (name, phone, chat ID and the whole chat) in your database.

**Flow**

```text
OpenWA dashboard ──(click "Save lead")──► OpenWA server ──POST JSON──► https://your-site.com/api/openwa/webhook
                                                                           │
                                                                           ├─ verify signature
                                                                           ├─ skip duplicates
                                                                           └─ save to `leads` + `lead_messages`
```

Works on Laravel 10, 11 and 12 (PHP 8.1+). Differences between versions are noted where they matter.

### Quick checklist

1. Laravel: add the secret (section 2), migrate (3), add the models (4), middleware (5), controller (6) and route (7).
2. OpenWA: if Laravel runs locally, allow its host in `SSRF_ALLOWED_HOSTS` and **restart OpenWA** (section 8).
3. OpenWA: make sure the WhatsApp session is **ready** (section 8).
4. OpenWA: create the webhook with the `lead.saved` event, then click **Test** (section 8).
5. Open a chat, click **Save lead**, and check the `leads` table (section 8.5).

---

## 1. What OpenWA sends

Each delivery is an HTTP `POST` with `Content-Type: application/json`.

### Headers

| Header                     | Meaning                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `X-OpenWA-Signature`       | `sha256=<hex>`: HMAC-SHA256 of the **raw body** using your webhook secret |
| `X-OpenWA-Event`           | Event name, e.g. `lead.saved` (or `test` from the Test button)            |
| `X-OpenWA-Idempotency-Key` | Same value on every retry of one delivery. Use it to skip duplicates.     |
| `X-OpenWA-Delivery-Id`     | Unique ID of this delivery (stable across retries)                        |
| `X-OpenWA-Retry-Count`     | `0` on the first attempt, then 1, 2, …                                    |

### Body

```json
{
  "event": "lead.saved",
  "timestamp": "2026-10-02T10:15:30.000Z",
  "sessionId": "my-session",
  "idempotencyKey": "lead_my-session_923001234567@c.us_2026-10-02T10:15:30.000Z",
  "deliveryId": "dlv_6f1c…",
  "data": {
    "sessionId": "my-session",
    "chatId": "923001234567@c.us",
    "name": "Ali Khan",
    "phone": "923001234567",
    "isGroup": false,
    "savedAt": "2026-10-02T10:15:30.000Z",
    "totalMessages": 342,
    "truncated": false,
    "messageCount": 342,
    "messages": [
      {
        "id": "3EB0A1B2C3D4E5F6",
        "direction": "incoming",
        "fromMe": false,
        "from": "923001234567@c.us",
        "author": null,
        "senderName": "Ali Khan",
        "type": "text",
        "body": "Assalam o Alaikum, price kya hai?",
        "mediaMimetype": null,
        "status": "read",
        "timestamp": 1790000000,
        "createdAt": "2026-10-01T09:00:00.000Z"
      }
    ]
  }
}
```

Notes on the fields:

- `phone` can be `null` (for example for a group, or a privacy `@lid` ID that could not be resolved).
- `messages` is **oldest first**: what OpenWA stored, plus the chat's history read live from WhatsApp (up to 2000), without duplicates. A message known only from the live history has `status: null`. Media files are not included, only `type` (`image`, `video`, `document`, …) and `mediaMimetype`.
- `truncated: true` means only the newest `messageCount` of `totalMessages` were sent (payload limit 1 MB / max 5000 messages).
- `timestamp` on a message is Unix **seconds** and may be `null`. Fall back to `createdAt` in that case.
- Saving the same chat again sends a **new** delivery with the full chat again. The code below updates the existing lead and only adds messages it has not seen.

---

## 2. Configuration

### `.env`

```dotenv
# Must be exactly the same secret you enter in OpenWA (16–255 characters)
OPENWA_WEBHOOK_SECRET=paste-a-long-random-secret-here
```

Generate one with `php -r "echo bin2hex(random_bytes(32)), PHP_EOL;"`, or use the **Generate** button in OpenWA and copy it here.

### `config/services.php`

Add to the returned array:

```php
'openwa' => [
    'webhook_secret' => env('OPENWA_WEBHOOK_SECRET'),
],
```

Run `php artisan config:clear` after changing `.env` (or `config:cache` in production).

---

## 3. Database

```bash
php artisan make:migration create_openwa_lead_tables
```

```php
<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // One row per WhatsApp chat saved as a lead.
        Schema::create('leads', function (Blueprint $table) {
            $table->id();
            $table->string('session_id');
            $table->string('chat_id');
            $table->string('name')->nullable();
            $table->string('phone', 32)->nullable()->index();
            $table->boolean('is_group')->default(false);
            $table->unsignedInteger('total_messages')->default(0);
            $table->boolean('truncated')->default(false);
            $table->timestamp('last_saved_at')->nullable();
            $table->timestamps();

            $table->unique(['session_id', 'chat_id']);
        });

        // The chat transcript.
        Schema::create('lead_messages', function (Blueprint $table) {
            $table->id();
            $table->foreignId('lead_id')->constrained()->cascadeOnDelete();
            $table->string('wa_message_id');
            $table->string('direction', 16);          // incoming | outgoing
            $table->boolean('from_me')->default(false);
            $table->string('from')->nullable();
            $table->string('author')->nullable();     // real sender inside a group
            $table->string('sender_name')->nullable();
            $table->string('type', 32)->default('text');
            $table->longText('body')->nullable();
            $table->string('media_mimetype')->nullable();
            $table->string('status', 16)->nullable();
            $table->timestamp('sent_at')->nullable();
            $table->timestamps();

            $table->unique(['lead_id', 'wa_message_id']);
        });

        // Remembers processed deliveries so a retry is not stored twice.
        Schema::create('openwa_webhook_receipts', function (Blueprint $table) {
            $table->id();
            $table->string('idempotency_key')->unique();
            $table->string('event', 64);
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('lead_messages');
        Schema::dropIfExists('leads');
        Schema::dropIfExists('openwa_webhook_receipts');
    }
};
```

```bash
php artisan migrate
```

> Messages can contain emoji. On MySQL make sure the connection uses `utf8mb4` (the Laravel default).

---

## 4. Models

`app/Models/Lead.php`

```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Lead extends Model
{
    protected $fillable = [
        'session_id', 'chat_id', 'name', 'phone', 'is_group',
        'total_messages', 'truncated', 'last_saved_at',
    ];

    protected $casts = [
        'is_group' => 'boolean',
        'truncated' => 'boolean',
        'last_saved_at' => 'datetime',
    ];

    public function messages(): HasMany
    {
        return $this->hasMany(LeadMessage::class)->orderBy('sent_at');
    }
}
```

`app/Models/LeadMessage.php`

```php
<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class LeadMessage extends Model
{
    protected $fillable = [
        'lead_id', 'wa_message_id', 'direction', 'from_me', 'from', 'author',
        'sender_name', 'type', 'body', 'media_mimetype', 'status', 'sent_at',
    ];

    protected $casts = [
        'from_me' => 'boolean',
        'sent_at' => 'datetime',
    ];

    public function lead(): BelongsTo
    {
        return $this->belongsTo(Lead::class);
    }
}
```

---

## 5. Signature middleware

Rejects any request that was not signed with your secret. The HMAC must be computed over the **raw** body (`$request->getContent()`), not over re-encoded JSON.

`app/Http/Middleware/VerifyOpenWASignature.php`

```php
<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class VerifyOpenWASignature
{
    public function handle(Request $request, Closure $next): Response
    {
        $secret = config('services.openwa.webhook_secret');
        $signature = (string) $request->header('X-OpenWA-Signature', '');

        if (! $secret || $signature === '') {
            abort(401, 'Missing signature');
        }

        $expected = 'sha256=' . hash_hmac('sha256', $request->getContent(), $secret);

        // Constant-time comparison.
        if (! hash_equals($expected, $signature)) {
            abort(401, 'Invalid signature');
        }

        return $next($request);
    }
}
```

---

## 6. Controller

`app/Http/Controllers/OpenWAWebhookController.php`

```php
<?php

namespace App\Http\Controllers;

use App\Models\Lead;
use App\Models\LeadMessage;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;

class OpenWAWebhookController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $payload = $request->json()->all();
        $event = $payload['event'] ?? $request->header('X-OpenWA-Event');

        // The "Test" button on the OpenWA Webhooks page sends event "test".
        if ($event === 'test') {
            return response()->json(['ok' => true, 'test' => true]);
        }

        // Answer 200 for events this endpoint does not handle, so OpenWA does not retry them.
        if ($event !== 'lead.saved') {
            return response()->json(['ok' => true, 'ignored' => $event]);
        }

        $key = $payload['idempotencyKey'] ?? $request->header('X-OpenWA-Idempotency-Key');
        $data = $payload['data'] ?? [];

        if (empty($data['chatId']) || empty($data['sessionId'])) {
            return response()->json(['ok' => false, 'error' => 'chatId/sessionId missing'], 422);
        }

        try {
            $lead = DB::transaction(function () use ($key, $event, $data) {
                // A retry of a delivery we already stored hits this unique key and is skipped.
                if ($key) {
                    DB::table('openwa_webhook_receipts')->insert([
                        'idempotency_key' => $key,
                        'event' => $event,
                        'created_at' => now(),
                        'updated_at' => now(),
                    ]);
                }

                return $this->storeLead($data);
            });
        } catch (UniqueConstraintViolationException) {
            return response()->json(['ok' => true, 'duplicate' => true]);
        }

        Log::info('OpenWA lead saved', ['lead_id' => $lead->id, 'chat_id' => $lead->chat_id]);

        return response()->json(['ok' => true, 'lead_id' => $lead->id]);
    }

    private function storeLead(array $data): Lead
    {
        $lead = Lead::updateOrCreate(
            ['session_id' => $data['sessionId'], 'chat_id' => $data['chatId']],
            [
                'name' => $data['name'] ?? null,
                'phone' => $data['phone'] ?? null,
                'is_group' => (bool) ($data['isGroup'] ?? false),
                'total_messages' => (int) ($data['totalMessages'] ?? 0),
                'truncated' => (bool) ($data['truncated'] ?? false),
                'last_saved_at' => isset($data['savedAt']) ? Carbon::parse($data['savedAt']) : now(),
            ],
        );

        $rows = [];
        foreach ($data['messages'] ?? [] as $m) {
            if (empty($m['id'])) {
                continue;
            }
            $sentAt = isset($m['timestamp'])
                ? Carbon::createFromTimestamp($m['timestamp'])
                : (isset($m['createdAt']) ? Carbon::parse($m['createdAt']) : null);

            $rows[] = [
                'lead_id' => $lead->id,
                'wa_message_id' => $m['id'],
                'direction' => $m['direction'] ?? 'incoming',
                'from_me' => (bool) ($m['fromMe'] ?? false),
                'from' => $m['from'] ?? null,
                'author' => $m['author'] ?? null,
                'sender_name' => $m['senderName'] ?? null,
                'type' => $m['type'] ?? 'text',
                'body' => $m['body'] ?? null,
                'media_mimetype' => $m['mediaMimetype'] ?? null,
                'status' => $m['status'] ?? null,
                'sent_at' => $sentAt,
                'created_at' => now(),
                'updated_at' => now(),
            ];
        }

        // Insert new messages and update known ones (status may have changed), in chunks.
        foreach (array_chunk($rows, 500) as $chunk) {
            LeadMessage::upsert(
                $chunk,
                ['lead_id', 'wa_message_id'],
                ['status', 'body', 'sender_name', 'updated_at'],
            );
        }

        return $lead;
    }
}
```

> `UniqueConstraintViolationException` exists from Laravel 10.20. On older versions catch `Illuminate\Database\QueryException` and check `$e->errorInfo[1] === 1062` (MySQL) instead.

---

## 7. Route

Webhooks must not go through CSRF protection, so use the API routes.

### Laravel 11 / 12

If `routes/api.php` does not exist yet, run `php artisan install:api` first. Then in `routes/api.php`:

```php
use App\Http\Controllers\OpenWAWebhookController;
use App\Http\Middleware\VerifyOpenWASignature;

Route::post('/openwa/webhook', OpenWAWebhookController::class)
    ->middleware(VerifyOpenWASignature::class);
```

### Laravel 10

Same code in `routes/api.php`. Optionally register an alias in `app/Http/Kernel.php` under `$middlewareAliases`:

```php
'openwa.signature' => \App\Http\Middleware\VerifyOpenWASignature::class,
```

and use `->middleware('openwa.signature')`.

The final URL is **`https://your-site.com/api/openwa/webhook`**.

> If you must use `routes/web.php` instead, exclude the path from CSRF. On Laravel 11/12 add `$middleware->validateCsrfTokens(except: ['openwa/webhook']);` in `bootstrap/app.php`. On Laravel 10 add it to `$except` in `app/Http/Middleware/VerifyCsrfToken.php`.

---

## 8. Set up the webhook in OpenWA

### 8.1 Allow a local Laravel host (skip for a public domain)

OpenWA blocks webhook URLs whose host is, or resolves to, `localhost`, `127.0.0.1` or a private IP (`192.168.x.x`, `10.x.x.x`). This protects against SSRF. Local dev domains such as `*.test` (Laragon, Valet, Herd) usually resolve to `127.0.0.1` through the hosts file, so they are blocked too.

Without this step, creating the webhook fails with:

```text
Failed to create webhook: Destination address is not allowed
```

1. Add the **exact host** from your webhook URL to the OpenWA `.env` (in the OpenWA project root, not Laravel's). Separate several hosts with commas:

   ```dotenv
   # Example: URL http://captaindunes.com-laravel.test/api/openwa/webhook
   SSRF_ALLOWED_HOSTS=captaindunes.com-laravel.test
   ```

   `data/.env.generated` works as well, but `.env` takes precedence. Put the value in only one file.

2. **Restart OpenWA.** The value is read once at startup. `npm run dev` restarts automatically when code changes, but **not when `.env` changes**. Stop it (Ctrl+C) and run `npm run dev` again. If the error persists after a restart, an old OpenWA process may still be holding port `2785`. Close every OpenWA terminal and check Task Manager for leftover `node.exe` processes.

3. The match is on the hostname only. The URL must use the same host you listed. `localhost`, `127.0.0.1` or a different spelling are not allowed unless you list them too.

A public `https://` domain needs none of this.

### 8.2 Make sure the WhatsApp session is ready

**Save lead** reads the chat from OpenWA, so the session must be connected. On the **Sessions** page the status must be **ready**, with the phone number shown.

If linking stops at **authenticated** and the page keeps loading, see the troubleshooting rows "Stuck after authenticated" in section 11.

### 8.3 Create the webhook

1. Open the OpenWA dashboard → **Webhooks** → **Add webhook**.
2. **Session**: the WhatsApp session you use for chats. A webhook belongs to one session. Leads from a chat in another session are not sent to it.
3. **URL**: `https://your-site.com/api/openwa/webhook`. For local dev, for example `http://captaindunes.com-laravel.test/api/openwa/webhook`.
4. **Events**: tick **`lead.saved`** only.
5. **Signing secret**: paste the same value as `OPENWA_WEBHOOK_SECRET` (16–255 characters). Or click **Generate** and copy the value into Laravel's `.env`, then run `php artisan config:clear`.
6. Make sure the webhook is **active** and save it.

### 8.4 Test the connection

1. Click **Test** on the webhook. Laravel should answer `200` with `{"ok":true,"test":true}`.
2. Open any chat in **Chats** → click **Save lead** in the chat header.
3. The dashboard shows one of these messages:

   | Message                                  | Meaning                                                                                         |
   | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
   | "Lead sent to 1 webhook(s)"              | Queued. Delivery happens in the background within a few seconds.                                |
   | "No webhook is subscribed to lead.saved" | Nothing was sent. The webhook is missing the event, is inactive, or belongs to another session. |
   | "Only the latest N messages fit…"        | Sent, but older messages were left out because of the size limit.                               |
   | "Could not save the lead"                | The request failed. The detail is shown under the message.                                      |

   "Lead sent" means OpenWA queued the delivery. It does not prove that Laravel saved it. Check that in 8.5.

### 8.5 Check the data in Laravel

```bash
php artisan tinker
```

```php
App\Models\Lead::latest('last_saved_at')->first();                // the lead you just saved
App\Models\Lead::latest('last_saved_at')->first()->messages()->count();
DB::table('openwa_webhook_receipts')->latest()->first();          // the delivery that was processed
```

If no row appears:

- Check `storage/logs/laravel.log` for an error.
- Ask OpenWA for failed deliveries. The dashboard has no page for this. Use the API with an ADMIN key (the default admin key is in OpenWA's `data/.api-key`):

  ```bash
  curl -H "X-API-Key: <admin-key>" "http://localhost:2785/api/webhooks/delivery-failures?limit=5"
  ```

  Each row shows the event, URL, attempts, `lastStatusCode` and `lastError`, for example `401` for a wrong secret or a timeout. Swagger at `http://localhost:2785/api/docs` lists the same route. A delivery that is still retrying is not listed yet. Retries wait 5 s, 10 s, 20 s and so on.

Saving the same chat again updates the same `leads` row (`last_saved_at` changes) and only adds messages that are new.

---

## 9. Test without OpenWA (curl)

Generate a signed request yourself to check the Laravel side:

```bash
SECRET='paste-a-long-random-secret-here'
BODY='{"event":"lead.saved","timestamp":"2026-10-02T10:00:00.000Z","sessionId":"s1","idempotencyKey":"manual-test-1","deliveryId":"dlv_test","data":{"sessionId":"s1","chatId":"923001234567@c.us","name":"Test Lead","phone":"923001234567","isGroup":false,"savedAt":"2026-10-02T10:00:00.000Z","totalMessages":1,"truncated":false,"messageCount":1,"messages":[{"id":"MSG1","direction":"incoming","fromMe":false,"from":"923001234567@c.us","author":null,"senderName":"Test Lead","type":"text","body":"Hello","mediaMimetype":null,"status":"read","timestamp":1790000000,"createdAt":"2026-10-02T10:00:00.000Z"}]}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"

curl -i -X POST https://your-site.com/api/openwa/webhook \
  -H "Content-Type: application/json" \
  -H "X-OpenWA-Signature: $SIG" \
  --data "$BODY"
```

Expected: `200 {"ok":true,"lead_id":1}`. Sending the same command again returns `{"ok":true,"duplicate":true}`. Change `idempotencyKey` to store it again.

---

## 10. Production tips

- **Answer quickly.** OpenWA waits up to 10 seconds (`WEBHOOK_TIMEOUT`) and retries on a timeout or any non-2xx response. For heavy extra work (CRM sync, emails), dispatch a queued job from the controller and return `200` straight away.
- **Return 2xx only after saving.** A `500` makes OpenWA retry. The idempotency table stops a retry from creating duplicates.
- **Body size.** A lead can be up to about 1 MB. Default PHP (`post_max_size=8M`) and nginx (`client_max_body_size 1m`) limits are close to that. Raise nginx to `2m` to be safe.
- **HTTPS.** Use an `https://` URL in production so the chat content is encrypted in transit.
- **Logs.** Failed deliveries are listed by `GET /api/webhooks/delivery-failures` (ADMIN key, see 8.5). On the Laravel side check `storage/logs/laravel.log`.

---

## 11. Troubleshooting

| Symptom                                                                   | Cause / fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Invalid signature`                                                   | Secret differs between OpenWA and `.env`, or `config:cache` is stale (`php artisan config:clear`). Never trim or re-encode the body.                                                                                                                                                                                                                                                                                                                                                         |
| `419 Page Expired`                                                        | Route is in `web.php` with CSRF on. Move it to `api.php` (section 7).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `404`                                                                     | API routes not installed (`php artisan install:api` on Laravel 11+), or the URL is missing the `/api` prefix.                                                                                                                                                                                                                                                                                                                                                                                |
| Dashboard says "No webhook is subscribed to lead.saved"                   | The webhook does not have the `lead.saved` event ticked, or it is disabled, or it belongs to a different session.                                                                                                                                                                                                                                                                                                                                                                            |
| "Destination address is not allowed" when creating or testing the webhook | The host resolves to localhost or a private IP. Add it to `SSRF_ALLOWED_HOSTS` in the OpenWA `.env`, then **fully restart OpenWA** (section 8.1). The same error after adding it almost always means OpenWA was not restarted, or an old OpenWA process still owns port 2785.                                                                                                                                                                                                                |
| Session stuck after "authenticated", page keeps loading                   | WhatsApp Web loaded a build that whatsapp-web.js cannot attach to. The OpenWA log shows `event bridge never attached`, and after about 2 minutes the session fails. Stop the session and **Start** it again. The login is kept, so no new QR scan is needed. If it keeps happening, pin a build that worked before in the OpenWA `.env`, e.g. `WWEBJS_WEB_VERSION=2.3000.1049045808-alpha`, and restart OpenWA. Builds are listed at github.com/wppconnect-team/wa-version (`html/` folder). |
| Phone says "Couldn't link device"                                         | Remove old OpenWA or Chrome entries under **Linked devices** on the phone (the limit is 4), update WhatsApp, then scan a fresh QR. If the phone asks for a passkey, see the OpenWA troubleshooting FAQ (`docs/12-troubleshooting-faq.md`).                                                                                                                                                                                                                                                   |
| Webhook test passes but "Save lead" stores nothing                        | Check `GET /api/webhooks/delivery-failures` in OpenWA (section 8.5) and `storage/logs/laravel.log`. Common causes are a secret mismatch (`401`), a response slower than 10 s, or nginx `413` (section 10).                                                                                                                                                                                                                                                                                   |
| `413 Request Entity Too Large`                                            | Raise `client_max_body_size` in nginx (section 10).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Lead saved but few messages                                               | `truncated` is true: the chat is larger than the payload limit, or WhatsApp itself holds only a few messages for the chat on the linked device (OpenWA sends its stored messages plus up to 2000 from the live history). Messages read only from the live history have `status: null`.                                                                                                                                                                                                       |
