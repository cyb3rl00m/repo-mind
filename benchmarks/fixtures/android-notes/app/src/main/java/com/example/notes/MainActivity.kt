package com.example.notes

import android.os.Bundle
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import com.example.notes.databinding.ActivityMainBinding
import com.example.notes.navigation.AppNavigator
import com.example.notes.ui.NoteListAdapter
import com.example.notes.ui.NotesViewModel

/** Main screen: shows the list of notes and a button to add a note. */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private val viewModel: NotesViewModel by viewModels { NotesViewModel.Factory((application as NotesApp).repository) }
    private val adapter = NoteListAdapter { note -> viewModel.toggleArchived(note) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.noteList.adapter = adapter
        binding.addButton.setOnClickListener {
            viewModel.addNote(binding.noteInput.text.toString())
            binding.noteInput.text.clear()
        }
        binding.settingsButton.setOnClickListener { AppNavigator.openSettings(this) }
        viewModel.notes.observe(this) { notes -> adapter.submit(notes) }
    }
}
