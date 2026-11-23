package com.example.notes

import android.app.Application
import com.example.notes.data.NotesDatabase
import com.example.notes.data.NoteRepository

class NotesApp : Application() {
    val repository: NoteRepository by lazy {
        NoteRepository(NotesDatabase.create(this).noteDao())
    }
}
