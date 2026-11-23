package com.example.notes.data

import kotlinx.coroutines.flow.Flow

/** Single source of truth for notes. */
class NoteRepository(private val dao: NoteDao) {
    fun observeActive(): Flow<List<Note>> = dao.observeActive()

    suspend fun add(text: String): Long = dao.insert(Note(text = text))

    suspend fun setArchived(id: Long, archived: Boolean) = dao.setArchived(id, archived)
}
