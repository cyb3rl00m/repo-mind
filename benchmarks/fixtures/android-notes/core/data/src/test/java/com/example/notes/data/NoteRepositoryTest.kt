package com.example.notes.data

import org.junit.Assert.assertEquals
import org.junit.Test

class NoteRepositoryTest {
    @Test
    fun noteDefaultsToActive() {
        assertEquals(false, Note(text = "a").archived)
    }
}
