package com.example.notes.ui

import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.recyclerview.widget.RecyclerView
import com.example.notes.data.Note
import com.example.notes.databinding.ItemNoteBinding

class NoteListAdapter(private val onToggle: (Note) -> Unit) : RecyclerView.Adapter<NoteListAdapter.Holder>() {
    private var items: List<Note> = emptyList()

    fun submit(notes: List<Note>) {
        items = notes
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(ItemNoteBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val note = items[position]
        holder.binding.noteText.text = note.text
        holder.binding.root.setOnClickListener { onToggle(note) }
    }

    override fun getItemCount(): Int = items.size

    class Holder(val binding: ItemNoteBinding) : RecyclerView.ViewHolder(binding.root)
}
