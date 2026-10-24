// Prénoms usuels en France (et quelques prénoms internationaux fréquents), pour
// repérer « Julie Martin » ou « Julie » seule. Liste écrite à la main : elle ne
// prétend pas être complète. Mots ambigus exclus (France, Rose, Grâce…), car un
// mot courant masqué à tort dégrade la réponse.
export const FIRST_NAMES = new Set(
  `Adam Adèle Adrien Agathe Agnès Aïcha Alain Albert Alexandre Alexis Alice Aline Alix Amandine Amélie Amina Anaïs André Andrée Ange Angèle Angélique
  Anne Annie Anthony Antoine Antonin Arnaud Arthur Aurélie Aurélien Axel Baptiste Basile Bastien Béatrice Benjamin Benoît Bernadette Bernard Bertrand
  Brigitte Bruno Camille Capucine Carine Carole Caroline Catherine Cécile Céline Chantal Charles Charlotte Chloé Christian Christiane Christine Christophe
  Claire Clara Claude Clément Clémence Colette Constance Corentin Corinne Cyril Damien Daniel Danielle David Delphine Denis Denise Didier Dominique
  Dylan Édith Édouard Élise Élisa Élodie Éloïse Emma Emmanuel Emmanuelle Enzo Éric Estelle Ethan Étienne Eva Ève Fabien Fabienne Fabrice Fanny Fatima
  Fatou Félix Florence Florian Francis Franck François Françoise Frédéric Frédérique Gabriel Gabrielle Gaël Gaëlle Gaston Geneviève Georges Gérard
  Germain Gilbert Gilles Ginette Gisèle Grégoire Grégory Guillaume Guy Hélène Henri Hervé Hugo Hugues Ibrahim Inès Irène Isabelle Jacqueline Jacques
  Jade Jean Jean-Claude Jean-François Jean-Louis Jean-Luc Jean-Marc Jean-Michel Jean-Paul Jean-Pierre Jeanne Jérémy Jérôme Joël Johanna Jonathan
  Joseph Josiane Josette Juliette Julie Julien Justine Karim Karine Kevin Laëtitia Laura Laure Laurence Laurent Léa Léna Léo Léon Léonie Liam Lina
  Line Lionel Loïc Louis Louise Luc Lucas Lucie Lucien Ludovic Lydie Madeleine Magali Maël Manon Marc Marcel Marguerite Marie Marie-Claire Marine
  Marion Marius Martin Martine Mathieu Mathilde Matthieu Maurice Maxime Maxence Mehdi Mélanie Michel Michèle Mickaël Mireille Mohamed Monique Morgane
  Muriel Myriam Nadia Nadine Natacha Nathalie Nathan Nicolas Nicole Noah Noé Noémie Océane Odile Olivier Pascal Pascale Patrice Patricia Patrick
  Paul Pauline Philippe Pierre Quentin Rachel Raphaël Raymond Rémi Renée René Richard Robert Roger Romain Sabine Sacha Samia Samuel Sandrine Sarah
  Sébastien Serge Simon Simone Solène Sophie Stéphane Stéphanie Suzanne Sylvain Sylvie Thérèse Thibault Thierry Thomas Timothée Tristan Valentin
  Valérie Vanessa Véronique Victor Vincent Virginie Xavier Yann Yannick Yasmine Yves Yvette Yvonne Zoé
  Ahmed Ali Hassan Omar Youssef Leïla Salma Sofia Aya Kenza Moussa Mamadou Aminata Kadiatou Mariam Nour Ryan Rayan Ilyes Wassim Lilou
  John James Michael Robert William Mary Jennifer Linda Elizabeth Sarah Emily Olivia Sophia Daniel Matthew Anna Maria Luca Marco Giulia Javier
  Carlos Lucia Miguel Pablo Hans Anja Lukas Lena Jan Piotr`
    .split(/\s+/)
    .filter(Boolean),
);
