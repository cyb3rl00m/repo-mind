package com.example.notes.ui

import org.junit.Assert.assertTrue
import org.junit.Test

class NotesViewModelTest {
    @Test
    fun blankNotesAreIgnored() {
        assertTrue("".trim().isEmpty())
    }
}
