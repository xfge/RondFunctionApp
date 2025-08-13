# RondFunctionApp

## EndLiveActivity Function

This function sends HTTP requests to the OneSignal Live Activities API to end live activities.

### Usage

The function accepts an `activity_id` parameter and sends an end request to OneSignal with predefined default values.

#### HTTP Methods
- `GET`: Pass `activity_id` as a query parameter
- `POST`: Pass `activity_id` in the request body or as a query parameter

#### Examples

**GET Request:**
```
GET /api/EndLiveActivity?activity_id=your-activity-id
```

**POST Request:**
```
POST /api/EndLiveActivity
Content-Type: application/json

{
  "activity_id": "your-activity-id"
}
```

#### Response

**Success (200):**
```json
{
  "success": true,
  "activity_id": "your-activity-id",
  "response": {
    // OneSignal API response
  }
}
```

**Error (400/500):**
```json
{
  "error": "Error description",
  "details": "Additional error details"
}
```

### Environment Variables

The following environment variables are configured in `local.settings.json`:

- `ONESIGNAL_APP_ID`: Your OneSignal App ID
- `ONESIGNAL_API_KEY`: Your OneSignal API Key

### Default Values

The function uses the following default values for the OneSignal API request:

- `event`: "end"
- `event_updates`: {}
- `name`: "Live Activity End"
- `contents.en`: "Your live activity has ended"
- `stale_date`: Current time + 1 hour
- `dismissal_date`: Current time + 2 hours
- `priority`: 5
- `ios_relevance_score`: 50
