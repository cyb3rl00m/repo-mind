package com.example.notes.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface NoteDao {
    @Query("SELECT * FROM notes WHERE archived = 0 ORDER BY created_at DESC")
    fun observeActive(): Flow<List<Note>>

    @Insert
    suspend fun insert(note: Note): Long

    @Query("UPDATE notes SET archived = :archived WHERE id = :id")
    suspend fun setArchived(id: Long, archived: Boolean)
}
