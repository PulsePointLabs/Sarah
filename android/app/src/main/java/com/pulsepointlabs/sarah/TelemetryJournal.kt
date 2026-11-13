package com.pulsepointlabs.sarah

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject

/** Private, append-only acquisition history. Server acknowledgements never delete it. */
object TelemetryJournal {
    private lateinit var db: SQLiteDatabase
    @Synchronized fun init(context: Context) {
        if (::db.isInitialized) return
        db = context.applicationContext.openOrCreateDatabase("telemetry_journal.db", Context.MODE_PRIVATE, null)
        db.enableWriteAheadLogging()
        db.execSQL("CREATE TABLE IF NOT EXISTS readings (row_id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, external_id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL, body TEXT NOT NULL)")
        db.execSQL("CREATE INDEX IF NOT EXISTS readings_source_time ON readings(source, received_at)")
    }
    @Synchronized fun append(source: String, id: String, receivedAt: Long, body: JSONObject) {
        check(::db.isInitialized) { "Local telemetry store is unavailable" }
        val row = ContentValues().apply { put("source",source);put("external_id",id);put("received_at",receivedAt);put("body",body.toString()) }
        db.insertWithOnConflict("readings",null,row,SQLiteDatabase.CONFLICT_IGNORE)
    }
    @Synchronized fun recent(source: String, limit: Int = 100): JSONArray {
        val rows = JSONArray()
        db.rawQuery("SELECT body FROM readings WHERE source=? ORDER BY received_at DESC, row_id DESC LIMIT ?",arrayOf(source,limit.coerceIn(1,1000).toString())).use { c ->
            while(c.moveToNext()) rows.put(JSONObject(c.getString(0)))
        }
        return rows
    }
    fun export(write: (String) -> Unit) {
        db.rawQuery("SELECT source, received_at, body FROM readings ORDER BY row_id",null).use { c ->
            while(c.moveToNext()) write(JSONObject().put("source",c.getString(0)).put("received_at",c.getLong(1)).put("reading",JSONObject(c.getString(2))).toString()+"\n")
        }
    }
    @Synchronized fun count(): Long = db.rawQuery("SELECT count(*) FROM readings",null).use { c -> c.moveToFirst();c.getLong(0) }
    @Synchronized fun batch(source: String, after: Long, limit: Int = 100): JSONArray {
        val rows=JSONArray()
        db.rawQuery("SELECT row_id, external_id, body FROM readings WHERE source=? AND row_id>? ORDER BY row_id LIMIT ?",arrayOf(source,after.toString(),limit.toString())).use { c ->
            while(c.moveToNext())rows.put(JSONObject().put("rowId",c.getLong(0)).put("id",c.getString(1)).put("reading",JSONObject(c.getString(2))))
        }
        return rows
    }
}
